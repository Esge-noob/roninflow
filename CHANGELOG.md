# Changelog

Each release's notes on GitHub come from its section here (`## x.y.z`, newest first).

## 1.7.0

- **Full-screen charts:** the expand button on any execution chart opens it full screen with TradingView-style tools.
  - **Drawing tools:** trend line, ray, horizontal line and ray, vertical line, rectangle, Fibonacci retracement, measure, long / short position (target, stop, R:R), brush and text — text can be resized and rotated. A magnet that snaps to the candles, hide, undo and delete; drawings are saved per instrument.
  - **Indicators:** EMA, SMA, VWAP, Bollinger Bands, RSI and MACD, plus volume. Timeframes from 1m to 1d, your executions on or off, chart colours (the palette button) and a screenshot button.
- **Market replay:** press Replay in the full-screen chart to step through the session bar by bar — play at 1× to 60×, step forward or back, jump to your next execution — with your fills, position and P&L appearing as they happened. Start from the first bar, 30 minutes before your first trade, or a bar you pick on the chart.
- **Your own dashboards:** add, rename and delete dashboards from the dashboard picker; each one keeps its own layout.
- **Ronin Score widget:** one 0–100 score from six parts (win %, profit factor, avg win/loss, recovery factor, max drawdown, consistency) on a radar. Click the title for how it's worked out, or **Weakest:** for what your score says about your trading — each part with your number, what it means and what to work on. Shrink it to KPI-card size and it keeps the radar (labels on hover) and the score.
- **Custom Chart widgets** (three of them): pick what goes along the bottom (day of week, hour, symbol, strategy, tag, market condition, account, each day / week / month…) and up to three metrics (net P&L, win %, trade count, profit factor, average win / loss, hold time…) as bars or lines.
- **Cross Analysis widget:** P&L (or win %) by symbol across weekdays, weeks, months or quarters as a heat map.
- **New default dashboard** for new installs and the live demo: six KPI cards (with the Ronin Score), account progress, Net P&L, hold time, edge blockers, weekday / hour / symbols, average day / trade, streaks, risk, drawdown and the calendar.
- **Live demo:** execution charts, the full-screen chart and replay now work with made-up prices that pass through the demo trades.
- Pop-ups on dashboard cards are no longer cut off by the card edge.

## 1.6.2

- **Market conditions and strategy performance on monthly, quarterly and yearly reviews:** a card per market condition and per strategy with a small P&L curve, P&L, win rate and profit factor for that period (plus "No condition logged" / "No strategy" cards). Click one for its full stats — EV, Performance Ratio, ROMAD, the metric grid and the equity curve — with a condition's "How to spot it" or a strategy's rules on top.
- **Strategy page:** Trading strategies now match Market conditions — the same 30 days / 90 days / 1 year / All time range, a "best strategy" line, cards with the P&L curve, Net P&L, win rate, trades and EV per trade, and the stats pop-up on click (with a button to the strategy's page). Market condition cards look the same and open their stats too.
- A strategy's own page uses the same stats layout (EV / PR / ROMAD, metric grid, equity curve) above its checklist, notes and trades.
- The Strategy page now follows the account picker, like Market conditions (it used to count trades from every account).

## 1.6.1

- **Price data settings:** every source in Settings → Price data now has an on/off switch.
  - **Your platform add-on** is on by default. The badge shows when bars are coming in ("Receiving · 2 symbols", or "On · waiting for bars"). Off: charts don't use your platform's bars and the add-ons stop fetching them.
  - **Use bars from:** if you're connected to more than one platform, pick which one the charts use — or leave it on "Any platform" (the one with the most data for that day). Only the chosen platform's add-on fetches bars. Bars are now kept per platform; ones saved before this still fill in any day the chosen platform hasn't sent.
  - **Databento and Polygon** can be switched off without removing the key.

## 1.6.0

- **Price data from every platform add-on:** the NinjaTrader, Quantower, cTrader, MetaTrader 4/5 and Sierra Chart add-ons now load the 1-minute bars for each day you traded from the platform's own data connection and send them for the diary's execution charts — no Databento, Polygon or Yahoo needed. Past days (up to 45) fill in when the add-on starts, today's chart keeps up as you trade, and a day that's done isn't fetched again. (ATAS already sent the bars of the 1-minute chart it's on.)
  - **Update your add-on to get this:** reinstall it the same way you installed it (e.g. `npm run addon:nt`, then F5 in the NinjaScript Editor; recompile the Expert Advisor in MetaEditor; rebuild the Sierra Chart study or cTrader cBot). Older add-ons keep syncing trades but don't send bars.
  - Sierra Chart opens a hidden 1-minute chart of each contract to read its bars, building the symbol from your chart's (e.g. MNQZ25 + "_FUT_CME").
- Settings → Price data and each add-on's help explain where the bars come from.

## 1.5.1

- **About RoninFlow in shared journals:** clicking the RoninFlow name at the top left of a view-only link or snapshot file opens a short popup explaining what RoninFlow is, with buttons to the GitHub repository and the latest download.

## 1.5.0

- **Share your journal, view-only:** a Share button at the top makes a link anyone can open to see your whole journal or just the page you're on (a review, a diary day, the dashboard…). Nobody can change anything, account numbers are hidden and accounts show as "Account 1, 2…", and only your first name appears. Pick when a link expires, optionally hide dollar amounts, and turn off or remove links any time; each link shows how often it's been viewed.
  - **Live links** work from anywhere through Tailscale Funnel (turn it on from the dialog) or your own public address. A page link only includes that page's dates.
  - **Snapshot file:** download a single HTML file of the same view that opens offline, with no server needed — handy for sending in a chat or email.
- **Sync trade reviews across accounts** (Review page): notes, tags, strategy, edge blockers, rating, screenshots and "reviewed" you add to a trade are saved on the same trade on your other accounts — all of them or the ones you pick — so a breached account's journal isn't lost. "Copy existing reviews now" fills in what's missing on past trades and shows what it will copy.

## 1.4.0

- **Risk profiles:** save any set of risk rules as a named profile (e.g. "$2k eval") for a given max drawdown, then have accounts follow it. Edit the profile once and every account on it updates; "Give it its own copy" splits one account off.
  - A profile made for an account's max drawdown is suggested automatically — in Risk rules and in the Add / Edit account form, which now has a **Risk rules** dropdown that picks the matching profile for you.
  - "Use a profile" switches an account to a profile; on the default plan, "Copy from a profile" loads a profile's rules.
  - Profiles appear in the "Rules for" picker with how many accounts use them; rename, change the drawdown size, edit or delete them there (deleting puts their accounts back on the default plan). The Risk page shows which profile an account follows.
- **Days to ruin** on the Current risk card: how many full max-loss days the account can take before hitting its max drawdown, running your risk rules forward — tiers step down with losing streaks and drawdown thresholds, each day capped at the firm's daily loss limit, measured to the account's real max-loss floor. Click it for the day-by-day path. Stacks under the title on phones.

## 1.3.0

- **Risk rules per account:** Risk rules now has a "Rules for" picker — the default plan or any account. Accounts use the default plan until you give them their own, either as a copy of the default or scaled to the account's max drawdown (with daily loss limits capped at the firm's). The Risk page, sidebar risk box and diary follow the plan of the account you're viewing, and the Start/Peak switch only changes that plan.
- **Add, remove and reorder tiers**, and choose which tier is Normal. Tiers above Normal stay locked until unlocked; losing streaks step you down one tier at a time.
- **Each tier sets the drawdown it kicks in at**, right in its row (leave it empty for streak-only tiers). Your existing two thresholds carry over. The Risk page's drawdown bar shows every threshold, how much room is left before the next one, and what it takes to climb out.
- Warnings in the editor when a daily loss limit is above the firm's, when tiers or thresholds are out of order, and each threshold as a % of the firm's max drawdown.
- **Profit target and max-loss lines on account charts.** The max-loss line follows the account's drawdown type — flat for static, stepping up after each best close for EOD trailing, and with the highest point reached for intraday trailing — and stops at the starting balance if the account is set to. Hover a day for its floor and the room left; daily bars show the daily loss limit instead. A Limits button hides them.

## 1.2.2

- **Big numbers fit their boxes everywhere:** the calendars (dashboard, monthly and quarterly reviews), review stat tiles and the Average Trade / Average Day widget now show a number in full when it fits, switch to the short form ($143k) when it doesn't, and shrink only if needed, based on the space each box actually has rather than the window size. Large days and weeks no longer spill out or get cut off with "…".
- The line under "Disciplined trades" wraps instead of hiding the cost of flagged trades, and the month review's "7 trades · 29%" no longer breaks across lines.

## 1.2.1

- **Weekly review numbers fit their tiles:** each day's and the week's P&L shrinks just enough to fit, so five- and six-figure days no longer spill out on smaller screens. The week's "trades · WR" line no longer wraps.

## 1.2.0

- **Build your own dashboard:** click **Edit layout**, then drag widgets anywhere (the others move out of the way, and dropping on a widget the same size swaps them), drag a corner to resize, or use the arrow keys on a widget's handle (Shift + arrows resizes). Undo, reset, and changes save as you go. The editing bar stays at the top while you scroll.
- **Add widgets** from a library with search and categories (Charts, Tables, KPIs, Calendar) — 26 in all. Every KPI is now its own widget, plus new ones: Long vs Short, Total Payouts, Equity Chart (your balance from the starting balance), Max Drawdown, Performance by Hold Duration, Strategy Performance and Performance by Tag. Some have options (the "Performance by…" widgets show P&L, win rate or trade count).
- My Dashboard, Performance, Risk and Psychology each keep their own layout. Your current dashboard opens as it was, including any widgets you'd hidden.
- On a phone the widgets stack in one column; you can still add, remove and configure them there.
- **Account selector on the Daily Diary** — on the sessions list (with each account's session count) and on each day's page. If the chosen account didn't trade that day but another did, the day says so.
- **Macro:** switch between the Economic Calendar and the COT Report from the page title instead of the sidebar.
- A change made just before closing or reloading the page is no longer lost — it's saved when the page opens again.

## 1.1.5

- **The update notice lists everything you'd get:** if you're several versions behind, it shows the notes of every release since yours (newest first), not just the latest — one update still installs them all.

## 1.1.4

- **The session score explains itself:** click it (diary, day pages, calendars) to see how it's worked out and your session's breakdown — base 33, win-rate points, profit-factor points and the +12 for a green day — plus where the remaining points are.

## 1.1.3

- **Every stat explains itself:** click a stat's name (dotted underline) on the dashboard, reviews, diary or strategies for what it means, how it's worked out, the usual benchmarks, and what *your* number says — e.g. your win rate compared with the win rate you need to break even at your average win and loss. Small samples are flagged.
- **Week tiles open that week's review** in a pop-up from every calendar (dashboard, journal, diary, monthly / quarterly reviews), with ‹ › to step through weeks.
- **2m and 3m** timeframes on the execution chart.

## 1.1.2

- **Timeframes on the execution chart:** click the timeframe (1m) for 1m, 5m, 10m, 15m, 30m, 1h, 4h or 1d. Bigger candles are built from your 1-minute data and count from the 6 PM ET futures session open, like TradingView; 1h, 4h and 1d also load the days before so there's enough history. Your choice is remembered. Timeframes finer than your price source provides are greyed out.
- **P&L by trade** in the review charts: a third option next to the equity curve and P&L by day, with one bar per trade in the order you took them.

## 1.1.1

- **New: Macro section** in the sidebar.
  - **Economic Calendar** — every release in your time zone as a list (today / this week / next week), a week or a month. Impact and currency filters, search, a live countdown to the next release and to the next high-impact event, actuals coloured better / worse than expected, and earlier releases of each event. Uses ForexFactory's public weekly feed (this week and next, kept as it arrives so history builds up). Actual figures, and the weeks ForexFactory hasn't published yet, come from TradingView's public calendar feed (can be switched off at the bottom of the page); official Fed and BLS dates are the fallback.
  - **COT Report** — the CFTC's weekly Commitments of Traders for about 30 futures markets (indices, rates, FX, metals, energy, crypto, grains): large speculators' net position and weekly change, % long, a COT index over 6 months / 1 year / 3 years with crowded long / short flags, commercials and open interest. Click a market for a 3-year chart and recent weeks, or add any other market in the report.
  - Both are fetched by RoninFlow's server (and by the home-server copy while your PC is off) and saved in `data/macro/`.
- **Market & bank holidays** in the calendar, months ahead: US (NYSE / CME closures, early closes, bond-market and bank holidays), UK, eurozone & Germany, Japan, Canada, Australia, New Zealand and Switzerland, with each country's weekend-substitute rules. Each says what it means for trading — markets closed, early close or banks only. Shown by default (Holiday filter).
- **Today's market events in the top bar:** a small note at the top right shows the next high-impact release today with a countdown (it turns red 15 minutes before), or a market holiday. Click it for today's list; hide it until tomorrow from there, or switch it off at the bottom of the Economic Calendar. It follows the calendar's currency filter.
- **ATAS add-on installer finds ATAS X in more places:** any drive, renamed or versioned folders, per-user installs, the Apps list, Start-menu shortcuts or a running ATAS. If it still can't, it asks you to paste the folder (with directions to find it) instead of stopping with a command meant for source-code installs.
- Add-on installers point to GitHub issues for build errors.
- A page opened from the sidebar now starts at the top instead of at the depth the previous page was scrolled to.

## 1.0.9

- **Mac and Linux setup steps for every platform add-on.** NinjaTrader, Quantower, Sierra Chart, MetaTrader, cTrader and ATAS now show the right steps for the computer RoninFlow runs on, with a Windows / Mac-Linux switch.
- **ATAS can send to a journal on another computer.** Journal Sync 1.3 has a Token setting, so ATAS on a Windows PC can send to RoninFlow on a Mac, Linux box or home server.
- **MetaTrader and Sierra Chart under Wine / CrossOver are found automatically**, including MetaQuotes' MT5 app for Mac.
- Windows steps now point installer users to Start menu → RoninFlow → Install platform add-ons.

## 1.0.8

- **Weekly review:** today is marked with a small violet dot after the day name instead of the word "Today", which made the header wrap onto two lines. Day headers now always stay on one line.
- Reviews say "1 trade" instead of "1 trades".

## 1.0.7

- **macOS and Linux:** RoninFlow now installs natively with one command — `curl -fsSL https://raw.githubusercontent.com/coreyheyman/roninflow/main/install.sh | bash`. No admin rights, Node.js included, starts at login (launchd / systemd), and the `roninflow` command manages it (`open`, `status`, `logs`, `update`, `uninstall`). Apple Silicon and Intel Macs; Linux x64 and arm64.
- **Update now** works on macOS and Linux too.
- Headless Linux servers: install with `--lan` and finish setup from another device.

## 1.0.6

- **One-click updates (Windows installer):** the "new version" notification now has an **Update now** button, also in Settings → Backups & updates. RoninFlow downloads the new installer from GitHub, checks it against the release's published SHA-256 checksum, backs up your journal, installs it and restarts itself — the page reloads on the new version. Docker and source installs get a **How to update** button with the exact commands.
- **Fixed:** updating with the Windows installer while RoninFlow was running could fail with a "file in use" error, because the installer no longer recognised the running app after the rename. It now stops the running copy reliably.
- Releases now include `SHA256SUMS.txt`, so you can verify any download yourself.

## 1.0.5

- **Weekly review:** removed the gaps that appeared between the day tiles on wide screens.
- **Dashboard calendar:** the daily P&L is now the same size as on the journal calendar instead of a small fixed size.
- **Review calendar on small phones:** amounts switch to a short form (+$1.3k) so they fit, like the dashboard calendar.

## 1.0.4

- **Calendars:** today is now marked with a violet outline around its tile and a violet date, instead of a circle around the date. The circle took up so much room on a phone that it pushed the day's P&L out of the tile.
- **Calendars on small phones:** day tiles can grow slightly taller than square when they need to, and the amounts shrink to fit, so every day's P&L stays readable even on the smallest iPhones.

## 1.0.3

- **Weekly review:** the Mon–Fri tiles now have the same square-ish shape as the calendar day tiles instead of being wide and short, and the Week total lines up with them. Between roughly 760 and 1000px wide they lay out three across, and two across on a phone, so they never turn into narrow slivers.

## 1.0.2

- **Calendars:** day tiles are square-ish everywhere instead of short and wide — the dashboard calendar in particular is no longer squished. The tiles keep their shape as the window narrows, all the way down to a phone, and stop growing past 200px tall on very wide monitors.

## 1.0.1

- **Charts:** turning Yahoo off in Settings → Price data now really stops Yahoo charts — days already saved from Yahoo are no longer shown.
- **Charts:** micro contracts (MES, MNQ, MCL…) now use the price bars your platform add-on sends for the full-size contract (ES, NQ, CL…), and the other way round.
- **Updates:** when a new version is out you now get a notification in the app (bell icon), with a link to download it.
- **Live demo:** try RoninFlow in your browser with made-up data — https://coreyheyman.github.io/roninflow/

## 1.0.0

First public release.
