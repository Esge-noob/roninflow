// RoninFlow Sync — Quantower strategy (beta)
//
// Sends every fill (trade) from your connected Quantower accounts to RoninFlow, plus account balances.
// The journal pairs fills into round-trip trades. Read-only: it never places or changes orders.
// Price data: every minute it asks the journal which days you traded still lack 1-minute bars (GET /api/candles/wanted),
// loads them from your Quantower connection and sends them (POST /api/candles/ingest) for the diary charts.
//
// Install: npm run addon:qt (builds it into Quantower's Strategies folder; needs the free .NET SDK).
// Then in Quantower: Strategies Manager → "RoninFlow Sync" → Run.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using TradingPlatform.BusinessLayer;

namespace TradeJournal
{
    public sealed class TradeJournalSync : Strategy
    {
        private const string SyncVersion = "1.1.0-beta";

        [InputParameter("Journal address", 0)]
        public string JournalUrl = "http://127.0.0.1:5173/api/connect/ingest";

        [InputParameter("Token (only for a journal on another computer)", 1)]
        public string Token = "";

        [InputParameter("Days of history to send at start", 2, minimum: 0, maximum: 365, increment: 1, decimalPlaces: 0)]
        public int BackfillDays = 30;

        // fully qualified: inside a Strategy, "Core" could also mean a member of the base class
        private static global::TradingPlatform.BusinessLayer.Core QCore { get { return global::TradingPlatform.BusinessLayer.Core.Instance; } }
        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        private readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
        private readonly ConcurrentDictionary<string, bool> seen = new ConcurrentDictionary<string, bool>();
        private System.Threading.Timer timer;
        private int busy, failures;
        private DateTime lastHeartbeat = DateTime.MinValue;
        private DateTime nextPrices = DateTime.UtcNow.AddSeconds(20);
        private int priceBusy;
        private int tickBusy;   // ticks for RoninFlow's tick-by-tick replay, when it asks (every tick of this loop, ~5 s)
        private bool priceAnnounced;

        public TradeJournalSync() : base()
        {
            this.Name = "RoninFlow Sync";
            this.Description = "Sends your fills to RoninFlow (read-only, never trades).";
        }

        protected override void OnRun()
        {
            QCore.TradeAdded += this.OnTrade;
            this.Log("[RoninFlow] started — sending fills to " + this.JournalUrl);
            Task.Run(() => this.Backfill());
            this.timer = new System.Threading.Timer(_ => this.Tick(), null, 2000, 5000);
        }

        protected override void OnStop()
        {
            QCore.TradeAdded -= this.OnTrade;
            if (this.timer != null) { this.timer.Dispose(); this.timer = null; }
            this.Tick();
        }

        private void Backfill()
        {
            try
            {
                if (this.BackfillDays <= 0) return;
                var req = new TradesHistoryRequestParameters { From = DateTime.UtcNow.AddDays(-this.BackfillDays), To = DateTime.UtcNow.AddMinutes(1) };
                IList<Trade> list = QCore.GetTrades(req);
                int n = 0;
                if (list != null) foreach (Trade t in list) if (this.Enqueue(t)) n++;
                this.Log("[RoninFlow] queued " + n + " fill(s) from the last " + this.BackfillDays + " days");
            }
            catch (Exception e) { this.Log("[RoninFlow] couldn't load trade history: " + e.Message, StrategyLoggingLevel.Error); }
        }

        private void OnTrade(Trade t) { if (this.Enqueue(t)) this.nextPrices = DateTime.UtcNow.AddSeconds(15); }

        private bool Enqueue(Trade t)
        {
            try
            {
                if (t == null || t.Symbol == null) return false;
                string account = t.Account != null ? (t.Account.Name ?? t.Account.Id) : "Default";
                string id = !string.IsNullOrEmpty(t.Id) ? t.Id : (account + "|" + t.Symbol.Name + "|" + t.DateTime.Ticks + "|" + t.Side + "|" + t.Quantity + "|" + t.Price);
                if (!this.seen.TryAdd(account + "|" + id, true)) return false;

                double pointValue = double.NaN;
                try
                {
                    double tick = t.Symbol.TickSize;
                    double cost = t.Symbol.GetTickCost(t.Price);
                    if (tick > 0 && tick < 1e9 && cost > 0 && cost < 1e9) pointValue = cost / tick;
                }
                catch { }

                var sb = new StringBuilder("{");
                Str(sb, "id", id); sb.Append(',');
                Str(sb, "account", account); sb.Append(',');
                Str(sb, "symbol", t.Symbol.Name); sb.Append(',');
                Str(sb, "side", t.Side == Side.Buy ? "Buy" : "Sell"); sb.Append(',');
                Num(sb, "qty", Math.Abs(t.Quantity)); sb.Append(',');
                Num(sb, "price", t.Price); sb.Append(',');
                Str(sb, "time", Iso(t.DateTime)); sb.Append(',');
                Num(sb, "commission", t.Fee != null ? Math.Abs(t.Fee.Value) : 0);
                if (!double.IsNaN(pointValue)) { sb.Append(','); Num(sb, "pointValue", pointValue); }
                sb.Append('}');
                this.queue.Enqueue(sb.ToString());
                return true;
            }
            catch (Exception e) { this.Log("[RoninFlow] skipped a fill: " + e.Message, StrategyLoggingLevel.Error); return false; }
        }

        private void Tick()
        {
            if (Interlocked.Exchange(ref this.busy, 1) == 1) return;
            try
            {
                while (!this.queue.IsEmpty)
                {
                    var batch = new List<string>();
                    string s;
                    while (batch.Count < 200 && this.queue.TryPeek(out s)) { batch.Add(s); this.queue.TryDequeue(out s); }
                    string body = "{\"source\":\"quantower\",\"platform\":\"Quantower\",\"version\":\"" + SyncVersion + "\",\"fills\":[" + string.Join(",", batch) + "]}";
                    if (!this.Post(body))
                    {
                        // put them back (at the end — the journal sorts fills by time anyway) and retry in 5 s
                        foreach (string b in batch) this.queue.Enqueue(b);
                        return;
                    }
                }
                if ((DateTime.UtcNow - this.lastHeartbeat).TotalSeconds >= 30) this.Heartbeat();
                if (DateTime.UtcNow >= this.nextPrices)
                {
                    this.nextPrices = DateTime.UtcNow.AddSeconds(60);
                    if (Interlocked.Exchange(ref this.priceBusy, 1) == 0)
                        Task.Run(() => { try { this.PriceRound(); } finally { Interlocked.Exchange(ref this.priceBusy, 0); } });
                }
                if (Interlocked.Exchange(ref this.tickBusy, 1) == 0)
                    Task.Run(() => { try { this.TickRound(); } finally { Interlocked.Exchange(ref this.tickBusy, 0); } });
            }
            finally { Interlocked.Exchange(ref this.busy, 0); }
        }

        // ---------------------------------------------------------------- price data (1-minute bars for the diary charts)
        private void PriceRound()
        {
            try
            {
                string list = this.Get(this.ApiUrl("/api/candles/wanted?source=quantower&format=lines"));
                if (list == null) return;
                int done = 0;
                foreach (string raw in list.Split('\n'))
                {
                    string[] p = raw.Trim().Split('|');
                    long from, to;
                    if (p.Length < 4 || !long.TryParse(p[2], out from) || !long.TryParse(p[3], out to) || to <= from) continue;
                    if (this.SendBars(p[0], p[1], from, to) && ++done >= 6) break; // the rest next minute
                }
            }
            catch (Exception e) { this.Log("[RoninFlow] price data: " + e.Message, StrategyLoggingLevel.Error); }
        }

        /// <summary>False when Quantower doesn't have that symbol right now (nothing was asked for).</summary>
        private bool SendBars(string symbol, string contract, long from, long to)
        {
            global::TradingPlatform.BusinessLayer.Symbol sym = null;
            try { sym = QCore.Symbols.FirstOrDefault(s => s != null && (s.Name == contract || s.Id == contract)); } catch { }
            if (sym == null)
            {
                // not loaded right now (another connection, or an expired contract) — try again later
                return false;
            }
            var rows = new List<string>();
            HistoricalData hd = null;
            try
            {
                DateTime f = DateTimeOffset.FromUnixTimeSeconds(from).UtcDateTime, t = DateTimeOffset.FromUnixTimeSeconds(to).UtcDateTime;
                hd = sym.GetHistory(Period.MIN1, f, t);
                if (hd == null) return true;
                for (int i = 0; i < hd.Count; i++)
                {
                    var b = hd[i, SeekOriginHistory.Begin] as HistoryItemBar;
                    if (b == null) continue;
                    DateTime left = b.TimeLeft.Kind == DateTimeKind.Local ? b.TimeLeft.ToUniversalTime() : b.TimeLeft;
                    long open = new DateTimeOffset(DateTime.SpecifyKind(left, DateTimeKind.Utc)).ToUnixTimeSeconds();
                    if (open < from || open >= to) continue;
                    rows.Add("[" + open + "," + D(b.Open) + "," + D(b.High) + "," + D(b.Low) + "," + D(b.Close) + "," + D(b.Volume) + "]");
                }
            }
            catch (Exception e) { this.Log("[RoninFlow] price data for " + contract + ": " + e.Message + " — will try again", StrategyLoggingLevel.Error); return true; }
            finally { var d = hd as IDisposable; if (d != null) try { d.Dispose(); } catch { } }
            var body = new StringBuilder("{\"source\":\"quantower\",");
            Str(body, "symbol", symbol);
            body.Append(",\"from\":").Append(from).Append(",\"to\":").Append(to).Append(",\"bars\":[").Append(string.Join(",", rows)).Append("]}");
            if (this.Post(body.ToString(), this.ApiUrl("/api/candles/ingest")) && (!this.priceAnnounced || rows.Count > 0))
            {
                this.priceAnnounced = true;
                this.Log("[RoninFlow] price data: sent " + rows.Count + " one-minute bar(s) of " + contract);
            }
            return true;
        }

        // ---------------------------------------------------------------- ticks (tick-by-tick replay)
        // RoninFlow lists the hours a replay is waiting for; each is loaded as trade ticks (HistoryType.Last) and sent
        // back as [ms, price, size, side].
        private void TickRound()
        {
            try
            {
                string list = this.Get(this.ApiUrl("/api/candles/ticks/wanted?source=quantower&format=lines"));
                if (list == null) return; // journal not reachable, or an older journal
                foreach (string raw in list.Split('\n'))
                {
                    string[] p = raw.Trim().Split('|');
                    long from, to;
                    if (p.Length < 4 || !long.TryParse(p[2], out from) || !long.TryParse(p[3], out to) || to <= from) continue;
                    this.SendTicks(p[0], p[1], from, to);
                }
            }
            catch (Exception e) { this.Log("[RoninFlow] tick data: " + e.Message, StrategyLoggingLevel.Error); }
        }

        private void SendTicks(string symbol, string contract, long from, long to)
        {
            global::TradingPlatform.BusinessLayer.Symbol sym = null;
            try { sym = QCore.Symbols.FirstOrDefault(s => s != null && (s.Name == contract || s.Id == contract)); } catch { }
            if (sym == null) return; // not loaded right now — RoninFlow asks again
            var rows = new List<string>();
            HistoricalData hd = null;
            try
            {
                DateTime f = DateTimeOffset.FromUnixTimeSeconds(from).UtcDateTime, t = DateTimeOffset.FromUnixTimeSeconds(to).UtcDateTime;
                hd = sym.GetTickHistory(HistoryType.Last, f, t);
                if (hd != null)
                {
                    for (int i = 0; i < hd.Count; i++)
                    {
                        var it = hd[i, SeekOriginHistory.Begin] as HistoryItemLast;
                        if (it == null) continue;
                        DateTime left = it.TimeLeft.Kind == DateTimeKind.Local ? it.TimeLeft.ToUniversalTime() : it.TimeLeft;
                        long ms = new DateTimeOffset(DateTime.SpecifyKind(left, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
                        if (ms < from * 1000 || ms >= to * 1000) continue;
                        string ag = it.AggressorFlag.ToString();
                        int side = ag.IndexOf("Buy", StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : ag.IndexOf("Sell", StringComparison.OrdinalIgnoreCase) >= 0 ? -1 : 0;
                        rows.Add("[" + ms.ToString(CultureInfo.InvariantCulture) + "," + D(it.Price) + "," + D(it.Volume) + "," + side.ToString(CultureInfo.InvariantCulture) + "]");
                    }
                }
            }
            catch (Exception e) { this.Log("[RoninFlow] tick data for " + contract + ": " + e.Message + " — will try again", StrategyLoggingLevel.Error); return; }
            finally { var d = hd as IDisposable; if (d != null) try { d.Dispose(); } catch { } }
            int parts = Math.Max(1, (rows.Count + 19999) / 20000);
            for (int k = 0; k < parts; k++)
            {
                var body = new StringBuilder("{\"source\":\"quantower\",");
                Str(body, "symbol", symbol);
                body.Append(",\"from\":").Append(from).Append(",\"to\":").Append(to).Append(",\"part\":").Append(k).Append(",\"last\":").Append(k == parts - 1 ? "true" : "false");
                body.Append(",\"ticks\":[").Append(string.Join(",", rows.Skip(k * 20000).Take(20000))).Append("]}");
                if (!this.Post(body.ToString(), this.ApiUrl("/api/candles/ticks/ingest"))) return;
            }
            this.Log("[RoninFlow] tick data: sent " + rows.Count + " tick(s) of " + contract);
        }

        // http://127.0.0.1:5173/api/connect/ingest → http://127.0.0.1:5173 + path
        private string ApiUrl(string path)
        {
            string u = this.JournalUrl.Trim();
            int i = u.IndexOf("/api/", StringComparison.OrdinalIgnoreCase);
            return (i > 0 ? u.Substring(0, i) : u.TrimEnd('/')) + path;
        }

        private string Get(string target)
        {
            try
            {
                var msg = new HttpRequestMessage(System.Net.Http.HttpMethod.Get, target);
                if (!string.IsNullOrWhiteSpace(this.Token)) msg.Headers.TryAddWithoutValidation("Authorization", "Bearer " + this.Token.Trim());
                using (HttpResponseMessage res = http.SendAsync(msg).GetAwaiter().GetResult())
                    return res.IsSuccessStatusCode ? res.Content.ReadAsStringAsync().GetAwaiter().GetResult() : null;
            }
            catch { return null; }
        }

        private static string D(double v)
        {
            return double.IsNaN(v) || double.IsInfinity(v) ? "0" : v.ToString("R", CultureInfo.InvariantCulture);
        }

        private void Heartbeat()
        {
            this.lastHeartbeat = DateTime.UtcNow;
            var accts = new List<string>();
            var bals = new List<string>();
            foreach (Account a in QCore.Accounts)
            {
                if (a == null) continue;
                string name = a.Name ?? a.Id;
                var q = new StringBuilder(); Str(q, "n", name); accts.Add(q.ToString().Substring(4));
                var sb = new StringBuilder("{");
                Str(sb, "account", name); sb.Append(',');
                Num(sb, "balance", a.Balance);
                sb.Append('}');
                bals.Add(sb.ToString());
            }
            this.Post("{\"source\":\"quantower\",\"heartbeat\":{\"platform\":\"Quantower\",\"version\":\"" + SyncVersion + "\",\"accounts\":[" + string.Join(",", accts) + "],\"balances\":[" + string.Join(",", bals) + "]}}");
        }

        private bool Post(string json, string target = null)
        {
            try
            {
                var msg = new HttpRequestMessage(System.Net.Http.HttpMethod.Post, target ?? this.JournalUrl.Trim()) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
                if (!string.IsNullOrWhiteSpace(this.Token)) msg.Headers.TryAddWithoutValidation("Authorization", "Bearer " + this.Token.Trim());
                using (HttpResponseMessage res = http.SendAsync(msg).GetAwaiter().GetResult())
                {
                    if (res.IsSuccessStatusCode)
                    {
                        if (this.failures > 0) this.Log("[RoninFlow] connected again");
                        this.failures = 0;
                        return true;
                    }
                    this.Fail("the journal answered " + (int)res.StatusCode + ((int)res.StatusCode == 401 ? " — check the token" : ""));
                }
            }
            catch (Exception e) { this.Fail(e.Message); }
            return false;
        }

        private void Fail(string why)
        {
            this.failures++;
            if (this.failures == 1 || this.failures % 60 == 0)
                this.Log("[RoninFlow] couldn't reach " + this.JournalUrl + ": " + why + " (will keep retrying)", StrategyLoggingLevel.Error);
        }

        private static string Iso(DateTime t)
        {
            // Quantower keeps times in UTC; convert if a local time ever comes through
            DateTime u = t.Kind == DateTimeKind.Local ? t.ToUniversalTime() : t;
            return u.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) + "Z";
        }

        private static void Str(StringBuilder sb, string k, string v)
        {
            sb.Append('"').Append(k).Append("\":\"");
            foreach (char c in v ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            sb.Append('"');
        }

        private static void Num(StringBuilder sb, string k, double v)
        {
            sb.Append('"').Append(k).Append("\":");
            if (double.IsNaN(v) || double.IsInfinity(v)) sb.Append("null");
            else sb.Append(v.ToString("R", CultureInfo.InvariantCulture));
        }
    }
}
