//+------------------------------------------------------------------+
//| Trade Journal Sync — MetaTrader 5 Expert Advisor                  |
//|                                                                  |
//| Writes every closed position on this account to MetaTrader's     |
//| shared folder (Common\Files\TradeJournal), where the journal on  |
//| this PC picks it up within ~10 seconds. No web request settings  |
//| are needed (MetaTrader can't call the journal's local address).  |
//|                                                                  |
//| Install: copy to MQL5\Experts (npm run addon:mt does it), compile |
//| in MetaEditor (F7), then drag "TradeJournalSync" onto any chart. |
//| It only reads history — it never places or changes orders.       |
//+------------------------------------------------------------------+
#property copyright "Trade Journal"
#property version   "1.10"
#property description "Sends your closed trades and 1-minute price data to RoninFlow (read-only, never trades)."

input int BackfillDays = 30;   // Days of history to send when it starts

string g_trades;   // TradeJournal\mt5-<login>.jsonl
string g_status;   // TradeJournal\mt5-<login>.status.json
string g_login;
long   g_sent[];   // position ids already written this session
datetime g_lastCheck = 0;

//--- JSON helpers
string Esc(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
  }
string Num(double v) { return DoubleToString(v, 8); }
// server time → UTC ISO (uses the broker's current offset from GMT, rounded to 15 minutes)
string IsoUtc(datetime serverTime)
  {
   long off = (long)(TimeGMT() - TimeTradeServer());
   off = (long)MathRound(off / 900.0) * 900;
   MqlDateTime d;
   TimeToStruct((datetime)(serverTime + off), d);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ", d.year, d.mon, d.day, d.hour, d.min, d.sec);
  }
bool Sent(long id)
  {
   for(int i = 0; i < ArraySize(g_sent); i++) if(g_sent[i] == id) return true;
   return false;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_login  = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   g_trades = "TradeJournal\\mt5-" + g_login + ".jsonl";
   g_status = "TradeJournal\\mt5-" + g_login + ".status.json";
   FolderCreate("TradeJournal", FILE_COMMON);
   ArrayResize(g_sent, 0);
   int n = Scan(TimeCurrent() - (datetime)BackfillDays * 86400);
   WriteStatus();
   PrintFormat("[Trade Journal] started for account %s — %d closed trade(s) sent from the last %d days", g_login, n, BackfillDays);
   EventSetTimer(5);
   return(INIT_SUCCEEDED);
  }
void OnDeinit(const int reason) { EventKillTimer(); }
int g_ticks = 0;
void OnTimer()
  {
   // look back a day each time; positions already written are skipped (and the journal ignores repeats)
   Scan(TimeCurrent() - 86400);
   WriteStatus();
   if(g_ticks++ % 12 == 2) PriceRound();   // about once a minute
  }
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD) { Scan(TimeCurrent() - 86400); }
  }

//+------------------------------------------------------------------+
//| Find positions with a closing deal since `from`, write the ones  |
//| that are now flat.                                               |
//+------------------------------------------------------------------+
int Scan(datetime from)
  {
   if(!HistorySelect(from, TimeCurrent() + 86400)) return 0;
   long ids[];
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      long type  = HistoryDealGetInteger(deal, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) continue;
      long pos = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(pos == 0 || Sent(pos)) continue;
      bool have = false;
      for(int k = 0; k < ArraySize(ids); k++) if(ids[k] == pos) { have = true; break; }
      if(!have) { int s = ArraySize(ids); ArrayResize(ids, s + 1); ids[s] = pos; }
     }
   int written = 0;
   for(int k = 0; k < ArraySize(ids); k++) if(WritePosition(ids[k])) written++;
   return written;
  }

bool WritePosition(long pos)
  {
   if(!HistorySelectByPosition(pos)) return false;
   int n = HistoryDealsTotal();
   double net = 0, inVol = 0, inNot = 0, outVol = 0, outNot = 0, pnl = 0, fees = 0;
   int dir = 0;
   datetime first = 0, last = 0;
   string symbol = "";
   for(int i = 0; i < n; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long type = HistoryDealGetInteger(deal, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;
      double vol   = HistoryDealGetDouble(deal, DEAL_VOLUME);
      double price = HistoryDealGetDouble(deal, DEAL_PRICE);
      datetime t   = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
      int side = (type == DEAL_TYPE_BUY) ? 1 : -1;
      if(dir == 0) { dir = side; first = t; symbol = HistoryDealGetString(deal, DEAL_SYMBOL); }
      if(side == dir) { inVol += vol; inNot += vol * price; } else { outVol += vol; outNot += vol * price; }
      net += side * vol;
      last = t;
      double comm = HistoryDealGetDouble(deal, DEAL_COMMISSION) + HistoryDealGetDouble(deal, DEAL_FEE);
      pnl  += HistoryDealGetDouble(deal, DEAL_PROFIT) + HistoryDealGetDouble(deal, DEAL_SWAP) + comm;
      fees -= comm;
     }
   if(dir == 0 || inVol <= 0 || outVol <= 0) return false;
   if(MathAbs(net) > 1e-8) return false; // still open (partly closed) — written once it's flat
   string line = StringFormat("{\"id\":\"mt5-%s-%s\",\"platform\":\"MetaTrader 5\",\"version\":\"1.0.0\",\"account\":\"%s\",\"symbol\":\"%s\",\"direction\":\"%s\",\"qty\":%s,\"entryTime\":\"%s\",\"exitTime\":\"%s\",\"entryPrice\":%s,\"exitPrice\":%s,\"pnl\":%s,\"fees\":%s}",
                              g_login, IntegerToString(pos), g_login, Esc(symbol), dir > 0 ? "Long" : "Short", Num(inVol), IsoUtc(first), IsoUtc(last),
                              Num(inNot / inVol), Num(outNot / outVol), Num(pnl), Num(fees));
   int h = FileOpen(g_trades, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) { PrintFormat("[Trade Journal] can't open %s (error %d)", g_trades, GetLastError()); return false; }
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, line + "\n");
   FileClose(h);
   int s = ArraySize(g_sent); ArrayResize(g_sent, s + 1); g_sent[s] = pos;
   return true;
  }

void WriteStatus()
  {
   int h = FileOpen(g_status, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, StringFormat("{\"platform\":\"MetaTrader 5\",\"version\":\"1.0.0\",\"account\":\"%s\",\"server\":\"%s\",\"balance\":%s,\"equity\":%s,\"currency\":\"%s\"}",
                                   g_login, Esc(AccountInfoString(ACCOUNT_SERVER)), Num(AccountInfoDouble(ACCOUNT_BALANCE)), Num(AccountInfoDouble(ACCOUNT_EQUITY)), AccountInfoString(ACCOUNT_CURRENCY)));
   FileClose(h);
  }
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| Price data: the journal lists the days you traded that still lack |
//| 1-minute bars (Common\Files\TradeJournal\price-wanted.txt, lines  |
//| "symbol|contract|from|to" in UTC unix seconds). This EA copies    |
//| them from MetaTrader's history and drops them next to it as       |
//| mt5-<login>.bars.jsonl, which the journal reads.             |
//+------------------------------------------------------------------+
string   g_recent[];      // ranges sent in the last few minutes (the journal updates the list about once a minute)
datetime g_recentAt[];
bool     g_priceAnnounced = false;

bool RecentlySent(string key)
  {
   for(int i = 0; i < ArraySize(g_recent); i++) if(g_recent[i] == key && TimeLocal() - g_recentAt[i] < 300) return true;
   return false;
  }
void RememberSent(string key)
  {
   int n = ArraySize(g_recent);
   for(int i = 0; i < n; i++) if(TimeLocal() - g_recentAt[i] >= 300) { g_recent[i] = key; g_recentAt[i] = TimeLocal(); return; }
   ArrayResize(g_recent, n + 1); ArrayResize(g_recentAt, n + 1);
   g_recent[n] = key; g_recentAt[n] = TimeLocal();
  }

void PriceRound()
  {
   int h = FileOpen("TradeJournal\\price-wanted.txt", FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return;   // nothing listed yet
   string lines[];
   while(!FileIsEnding(h))
     {
      string l = FileReadString(h);
      StringTrimLeft(l); StringTrimRight(l);
      if(StringLen(l) == 0) continue;
      int n = ArraySize(lines); ArrayResize(lines, n + 1); lines[n] = l;
     }
   FileClose(h);
   int done = 0;
   for(int i = 0; i < ArraySize(lines) && done < 3; i++)
     {
      string p[];
      if(StringSplit(lines[i], '|', p) < 4) continue;
      long from = StringToInteger(p[2]), to = StringToInteger(p[3]);
      if(to <= from || RecentlySent(lines[i])) continue;
      if(SendBars(p[0], p[1], from, to)) { RememberSent(lines[i]); done++; }
     }
  }

// false = not this terminal's symbol, or MetaTrader is still downloading the history (asked again next minute)
bool SendBars(string symbol, string name, long from, long to)
  {
   if(!SymbolSelect(name, true)) return false;
   long off = (long)(TimeGMT() - TimeTradeServer());     // server time → UTC
   off = (long)MathRound(off / 900.0) * 900;
   MqlRates rates[];
   int n = CopyRates(name, PERIOD_M1, (datetime)(from - off), (datetime)(to - off - 1), rates);
   if(n < 0) return false;
   int digits = (int)SymbolInfoInteger(name, SYMBOL_DIGITS);
   string bars = "";
   int count = 0;
   for(int i = 0; i < n; i++)
     {
      long t = (long)rates[i].time + off;
      if(t < from || t >= to) continue;
      if(count > 0) bars += ",";
      bars += "[" + IntegerToString(t) + "," + DoubleToString(rates[i].open, digits) + "," + DoubleToString(rates[i].high, digits) + "," + DoubleToString(rates[i].low, digits) + "," + DoubleToString(rates[i].close, digits) + "," + IntegerToString((long)rates[i].tick_volume) + "]";
      count++;
     }
   string line = "{\"source\":\"metatrader\",\"symbol\":\"" + Esc(symbol) + "\",\"from\":" + IntegerToString(from) + ",\"to\":" + IntegerToString(to) + ",\"bars\":[" + bars + "]}";
   int h = FileOpen("TradeJournal\\mt5-" + g_login + ".bars.jsonl", FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return false;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, line + "\n");
   FileClose(h);
   if(!g_priceAnnounced || count > 0) { g_priceAnnounced = true; PrintFormat("[RoninFlow] price data: sent %d one-minute bar(s) of %s", count, name); }
   return true;
  }
