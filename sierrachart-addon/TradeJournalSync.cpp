// RoninFlow Sync — Sierra Chart custom study (ACSIL)
//
// Add it to the chart(s) you trade from. Every fill for that chart's symbol and trade account is written to
// %LOCALAPPDATA%\TradeJournal\drop, which the journal on this PC reads every 10 seconds and pairs into trades.
// Read-only: it never places or changes orders.
//
// Price data: the journal lists the days you traded that still lack 1-minute bars (price-wanted.txt in the same folder,
// lines "symbol|contract|from|to" in UTC unix seconds). The study opens a hidden 1-minute chart for each one, reads its
// bars and drops them as sierrachart-<account>.bars.jsonl, which the journal reads for the diary charts.
//
// Install: npm run addon:sierra (copies this file into C:\SierraChart\ACS_Source), then in Sierra Chart:
// Analysis → Build Custom Studies DLL → select TradeJournalSync.cpp → Remote Build. Then add the study
// "RoninFlow Sync" to your trading chart(s) (Analysis → Studies → Add Custom Study).
#include "sierrachart.h"
#include <windows.h>
#include <cstdio>
#include <cctype>
#include <string>
#include <map>
#include <vector>

SCDLLName("RoninFlow Sync")

static std::string JsonEscape(const char* s)
{
	std::string out;
	for (const char* p = s ? s : ""; *p; ++p)
	{
		if (*p == '"' || *p == '\\') { out += '\\'; out += *p; }
		else if ((unsigned char)*p < 0x20) out += ' ';
		else out += *p;
	}
	return out;
}

// "ESZ25_FUT_CME", "ESZ25-CME", "ESZ5.CME" -> "ESZ25" / "ESZ5" (the journal recognises the root from that)
static std::string BaseSymbol(const char* s)
{
	std::string sym = s ? s : "";
	size_t cut = sym.find_first_of("_-.");
	if (cut != std::string::npos && cut > 0) sym = sym.substr(0, cut);
	return sym;
}

static std::string IsoUtc(const SCDateTime& t)
{
	int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, ms = 0;
	t.GetDateTimeYMDHMS_MS(y, mo, d, h, mi, s, ms);
	char buf[40];
	snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", y, mo, d, h, mi, s, ms);
	return buf;
}

static std::string DropFolder()
{
	char base[MAX_PATH] = { 0 };
	DWORD n = GetEnvironmentVariableA("LOCALAPPDATA", base, MAX_PATH);
	std::string dir = std::string(n > 0 && n < MAX_PATH ? base : "C:") + "\\TradeJournal";
	CreateDirectoryA(dir.c_str(), NULL);
	dir += "\\drop";
	CreateDirectoryA(dir.c_str(), NULL);
	return dir;
}

// Win32 file writes (no CRT fopen, so no "deprecated function" build errors)
static bool WriteFileText(const std::string& path, const std::string& text, bool append)
{
	HANDLE h = CreateFileA(path.c_str(), append ? FILE_APPEND_DATA : GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
		append ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
	if (h == INVALID_HANDLE_VALUE) return false;
	DWORD done = 0;
	BOOL ok = WriteFile(h, text.data(), (DWORD)text.size(), &done, NULL);
	CloseHandle(h);
	return ok && done == text.size();
}

static std::string SafeName(const std::string& s)
{
	std::string out;
	for (char c : s) out += (isalnum((unsigned char)c) ? c : '_');
	return out;
}

// ---------------------------------------------------------------- price data
static std::string ReadFileText(const std::string& path)
{
	HANDLE h = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
	if (h == INVALID_HANDLE_VALUE) return "";
	std::string out;
	char buf[8192];
	DWORD got = 0;
	while (ReadFile(h, buf, sizeof(buf), &got, NULL) && got > 0) out.append(buf, got);
	CloseHandle(h);
	return out;
}

// days since 1970-01-01 for a calendar date (no time zone involved)
static long long DaysFromCivil(int y, int m, int d)
{
	y -= m <= 2;
	long long era = (y >= 0 ? y : y - 399) / 400;
	long long yoe = y - era * 400;
	long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
	long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	return era * 146097 + doe - 719468;
}
static long long UnixUtc(const SCDateTime& gmt)
{
	int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, ms = 0;
	gmt.GetDateTimeYMDHMS_MS(y, mo, d, h, mi, s, ms);
	return DaysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

struct PriceJob
{
	std::string line, symbol, feed;
	long long from = 0, to = 0;
	int chart = 0;
	unsigned long long startedAt = 0, lastChangeAt = 0;
	int lastSize = -1;
};
static std::map<std::string, unsigned long long> g_priceRecent; // list line → when it was handled (asked again after 5 min)
static std::map<int, PriceJob> g_priceJobs;                       // one job at a time per chart running the study
static int g_priceOwner = 0;                                      // only one chart's study fetches prices
static unsigned long long g_priceOwnerSeen = 0;

// "MNQZ25" on a chart whose symbol is "ESZ25_FUT_CME" → "MNQZ25_FUT_CME" (the data feed's naming)
static std::string FeedSymbol(const std::string& contract, const char* chartSymbol)
{
	if (contract.find_first_of("_-.") != std::string::npos) return contract;
	std::string cs = chartSymbol ? chartSymbol : "";
	size_t cut = cs.find_first_of("_-.");
	return contract + (cut != std::string::npos && cut > 0 ? cs.substr(cut) : "");
}

static void PriceData(SCStudyInterfaceRef sc, const std::string& folder, const std::string& account)
{
	unsigned long long now = GetTickCount64();
	if (g_priceOwner != sc.ChartNumber)
	{
		if (g_priceOwner != 0 && now - g_priceOwnerSeen < 120000) return;
		g_priceOwner = sc.ChartNumber;
	}
	g_priceOwnerSeen = now;
	PriceJob& job = g_priceJobs[sc.ChartNumber];
	SCDateTime& lastList = sc.GetPersistentSCDateTime(2);

	if (job.chart == 0)
	{
		if (sc.CurrentSystemDateTime - lastList < SCDateTime::SECONDS(20)) return;
		lastList = sc.CurrentSystemDateTime;
		std::string text = ReadFileText(folder + "\\price-wanted.txt");
		size_t pos = 0;
		while (pos < text.size())
		{
			size_t eol = text.find('\n', pos);
			std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
			pos = eol == std::string::npos ? text.size() : eol + 1;
			while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
			if (line.empty()) continue;
			auto seen = g_priceRecent.find(line);
			if (seen != g_priceRecent.end() && now - seen->second < 300000) continue;
			std::vector<std::string> p;
			size_t a = 0, b;
			while ((b = line.find('|', a)) != std::string::npos) { p.push_back(line.substr(a, b - a)); a = b + 1; }
			p.push_back(line.substr(a));
			if (p.size() < 4) continue;
			long long from = _atoi64(p[2].c_str()), to = _atoi64(p[3].c_str());
			if (to <= from) continue;
			job = PriceJob();
			job.line = line; job.symbol = p[0]; job.from = from; job.to = to;
			job.feed = FeedSymbol(p[1], sc.Symbol.GetChars());
			long long nowUnix = UnixUtc(sc.AdjustDateTimeToGMT(sc.CurrentSystemDateTime));
			int days = (int)((nowUnix - from) / 86400) + 2;
			s_ACSOpenChartParameters op;
			op.PriorChartNumber = 0;
			op.ChartDataType = INTRADAY_DATA;
			op.Symbol = SCString(job.feed.c_str());
			op.IntradayBarPeriodType = IBPT_DAYS_MINS_SECS;
			op.IntradayBarPeriodLength = 60;
			op.DaysToLoad = days < 2 ? 2 : (days > 60 ? 60 : days);
			op.LoadWeekendData = 1;
			op.HideNewChart = 1;
			job.chart = sc.OpenChartOrGetChartReference(op);
			job.startedAt = job.lastChangeAt = now;
			if (job.chart <= 0)
			{
				g_priceRecent[line] = now; // couldn't open a chart for it — try again in a few minutes
				job = PriceJob();
			}
			break;
		}
		return;
	}

	// wait until the hidden chart has loaded its data (the bar count stops changing)
	SCDateTimeArray times;
	sc.GetChartDateTimeArray(job.chart, times);
	int size = times.GetArraySize();
	if (size != job.lastSize) { job.lastSize = size; job.lastChangeAt = now; }
	bool settled = size > 0 && now - job.lastChangeAt > 5000;
	if (!settled && now - job.startedAt < 120000) return;

	g_priceRecent[job.line] = now;
	if (size > 0)
	{
		SCGraphData data;
		sc.GetChartBaseData(job.chart, data);
		std::string bars;
		int count = 0;
		for (int i = 0; i < size; ++i)
		{
			long long t = UnixUtc(sc.AdjustDateTimeToGMT(times[i]));
			if (t < job.from || t >= job.to) continue;
			char row[200];
			snprintf(row, sizeof(row), "%s[%lld,%.10g,%.10g,%.10g,%.10g,%.10g]", count ? "," : "", t,
				(double)data[SC_OPEN][i], (double)data[SC_HIGH][i], (double)data[SC_LOW][i], (double)data[SC_LAST][i], (double)data[SC_VOLUME][i]);
			bars += row;
			++count;
		}
		char range[100];
		snprintf(range, sizeof(range), ",\"from\":%lld,\"to\":%lld,\"bars\":[", job.from, job.to);
		std::string line = "{\"source\":\"sierrachart\",\"symbol\":\"" + JsonEscape(job.symbol.c_str()) + "\"" + range + bars + "]}\n";
		if (WriteFileText(folder + "\\sierrachart-" + SafeName(account) + ".bars.jsonl", line, true))
		{
			char msg[300];
			snprintf(msg, sizeof(msg), "RoninFlow Sync: sent %d one-minute bar(s) of %s", count, job.feed.c_str());
			sc.AddMessageToLog(SCString(msg), 0);
		}
	}
	else
	{
		std::string m = "RoninFlow Sync: no price data for " + job.feed + " (check the symbol) - will try again later";
		sc.AddMessageToLog(SCString(m.c_str()), 0);
	}
	job = PriceJob();
}

SCSFExport scsf_TradeJournalSync(SCStudyInterfaceRef sc)
{
	SCInputRef InTimesAreUtc = sc.Input[0];

	if (sc.SetDefaults)
	{
		sc.GraphName = "RoninFlow Sync";
		sc.StudyDescription = "Sends this chart's fills (symbol + trade account) and 1-minute price data for the days you traded to RoninFlow. Read-only, never trades.";
		sc.AutoLoop = 0;
		sc.GraphRegion = 0;
		sc.UpdateAlways = 1; // keep running (and writing the 'alive' status) even when the market is quiet

		InTimesAreUtc.Name = "Fill times are already UTC (leave No unless times show up shifted)";
		InTimesAreUtc.SetYesNo(0);
		return;
	}

	int& written = sc.GetPersistentInt(1);       // fills already written this session
	int& announced = sc.GetPersistentInt(2);
	SCDateTime& lastStatus = sc.GetPersistentSCDateTime(1);

	std::string account = sc.SelectedTradeAccount.GetChars();
	if (account.empty()) account = "Sim1";
	std::string folder = DropFolder();
	std::string tag = SafeName(account + "-" + BaseSymbol(sc.Symbol.GetChars()));
	std::string fillsFile = folder + "\\sierrachart-" + tag + ".jsonl";
	std::string statusFile = folder + "\\sierrachart-" + tag + ".status.json";

	double pointValue = (sc.TickSize > 0 && sc.CurrencyValuePerTick > 0) ? sc.CurrencyValuePerTick / sc.TickSize : 0;

	int total = sc.GetOrderFillArraySize();
	if (total < written) written = 0; // fills reloaded (e.g. trade mode switched) — write again, repeats are ignored
	if (total > written)
	{
		std::string lines;
		for (int i = written; i < total; ++i)
		{
			s_SCOrderFillData fill;
			if (!sc.GetOrderFillEntry(i, fill)) continue;
			if (fill.Quantity == 0) continue;
			SCDateTime t = fill.FillDateTime;
			if (!InTimesAreUtc.GetYesNo()) t = sc.AdjustDateTimeToGMT(fill.FillDateTime); // Sierra Chart time zone → UTC
			std::string sym = BaseSymbol(fill.Symbol.GetChars());
			std::string acct = fill.TradeAccount.GetChars();
			if (acct.empty()) acct = account;
			std::string id = fill.FillExecutionServiceID.GetChars();
			if (id.empty()) { char b[64]; snprintf(b, sizeof(b), "%d-%d", fill.InternalOrderID, i); id = std::string(b) + "-" + IsoUtc(t); }
			char nums[200];
			snprintf(nums, sizeof(nums), "\"qty\":%u,\"price\":%.10g", (unsigned int)fill.Quantity, fill.FillPrice);
			std::string line = "{\"id\":\"" + JsonEscape(id.c_str()) + "\",\"platform\":\"Sierra Chart\",\"version\":\"1.0.0\",\"account\":\"" + JsonEscape(acct.c_str())
				+ "\",\"symbol\":\"" + JsonEscape(sym.c_str()) + "\",\"side\":\"" + (fill.BuySell == BSE_BUY ? "Buy" : "Sell") + "\"," + nums
				+ ",\"time\":\"" + IsoUtc(t) + "\"";
			if (pointValue > 0) { char pv[64]; snprintf(pv, sizeof(pv), ",\"pointValue\":%.10g", pointValue); line += pv; }
			if (fill.IsSimulated) line += ",\"simulated\":true";
			line += "}\n";
			lines += line;
		}
		if (lines.empty() || WriteFileText(fillsFile, lines, true)) written = total;
		else if (!announced)
		{
			std::string m = "RoninFlow Sync: can't write to " + folder;
			sc.AddMessageToLog(SCString(m.c_str()), 1);
		}
	}

	// 'alive' status every 5 seconds — the journal shows Sierra Chart as connected while this keeps changing
	if (sc.CurrentSystemDateTime - lastStatus > SCDateTime::SECONDS(5))
	{
		lastStatus = sc.CurrentSystemDateTime;
		std::string st = "{\"platform\":\"Sierra Chart\",\"version\":\"1.0.0\",\"account\":\"" + JsonEscape(account.c_str()) + "\",\"symbol\":\"" + JsonEscape(sc.Symbol.GetChars()) + "\"}";
		WriteFileText(statusFile, st, false);
	}

	PriceData(sc, folder, account);

	if (!announced)
	{
		announced = 1;
		char msg[400];
		snprintf(msg, sizeof(msg), "RoninFlow Sync started: %s on %s (%d fill(s) loaded) -> %s", sc.Symbol.GetChars(), account.c_str(), total, folder.c_str());
		sc.AddMessageToLog(SCString(msg), 0);
	}
}
