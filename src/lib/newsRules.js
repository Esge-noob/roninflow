// Built-in reading of market headlines (no AI): what a line is about, its story, its tone, and how that kind of news
// usually moves each market — with the steps in between ("Hawkish → rates stay high → … → gold ▼").
// Shared by the journal's server (news.js) and the browser (the demo's sample data). Plain rules: fast, free and
// predictable; your Trading Coach's AI can read the important lines instead (Settings on the News pages).

// ---------- markets ----------
/** Futures the news is traced to. cls picks the chain wording; yahoo is the free fallback for prices. */
export const NEWS_MARKETS = {
  ES: { label: 'S&P 500', short: 'S&P', cls: 'equity', yahoo: 'ES=F' },
  NQ: { label: 'Nasdaq-100', short: 'Nasdaq', cls: 'equity', yahoo: 'NQ=F' },
  YM: { label: 'Dow', short: 'Dow', cls: 'equity', yahoo: 'YM=F' },
  RTY: { label: 'Russell 2000', short: 'Russell', cls: 'equity', yahoo: 'RTY=F' },
  CL: { label: 'Crude oil', short: 'Oil', cls: 'oil', yahoo: 'CL=F' },
  NG: { label: 'Natural gas', short: 'Nat gas', cls: 'oil', yahoo: 'NG=F' },
  GC: { label: 'Gold', short: 'Gold', cls: 'gold', yahoo: 'GC=F' },
  SI: { label: 'Silver', short: 'Silver', cls: 'gold', yahoo: 'SI=F' },
  HG: { label: 'Copper', short: 'Copper', cls: 'copper', yahoo: 'HG=F' },
  ZN: { label: '10-year note', short: '10Y note', cls: 'bond', yahoo: 'ZN=F' },
  ZB: { label: '30-year bond', short: 'Bond', cls: 'bond', yahoo: 'ZB=F' },
  '6E': { label: 'Euro', short: 'Euro', cls: 'fx', yahoo: '6E=F', ccy: 'EUR' },
  '6B': { label: 'British pound', short: 'Pound', cls: 'fx', yahoo: '6B=F', ccy: 'GBP' },
  '6J': { label: 'Japanese yen', short: 'Yen', cls: 'yen', yahoo: '6J=F', ccy: 'JPY' },
  '6A': { label: 'Australian dollar', short: 'Aussie', cls: 'fx', yahoo: '6A=F', ccy: 'AUD' },
  '6C': { label: 'Canadian dollar', short: 'Loonie', cls: 'fx', yahoo: '6C=F', ccy: 'CAD' },
  BTC: { label: 'Bitcoin', short: 'Bitcoin', cls: 'crypto', yahoo: 'BTC=F' },
};
/** Micro and mini contracts follow their full-size market. */
export const MARKET_OF = { MES: 'ES', MNQ: 'NQ', MYM: 'YM', M2K: 'RTY', MCL: 'CL', QM: 'CL', QG: 'NG', MGC: 'GC', QO: 'GC', SIL: 'SI', QI: 'SI', MHG: 'HG', M6E: '6E', M6B: '6B', M6A: '6A', MBT: 'BTC', MET: 'BTC', MJY: '6J' };
const ROOTS = Object.keys({ ...NEWS_MARKETS, ...MARKET_OF }).sort((a, b) => b.length - a.length);
/** "MESZ6" / "MES 12-26" / "ES" → "ES"; null for markets the news isn't traced to. */
export function newsMarketOf(symbol) {
  const u = String(symbol || '').toUpperCase().trim();
  const r = ROOTS.find((x) => u.startsWith(x));
  if (!r) return null;
  return MARKET_OF[r] || r;
}

// ---------- drivers: kinds of news and how they usually push each class of market (+1 up, −1 down) ----------
const M = (equity, gold, oil, bond, fx, yen, crypto, copper) => ({ equity, gold, oil, bond, fx, yen, crypto, copper });
export const DRIVERS = {
  hawkish: { label: 'Hawkish', fx: M(-1, -1, 0, -1, -1, -1, -1, -1) },
  dovish: { label: 'Dovish', fx: M(1, 1, 0, 1, 1, 1, 1, 1) },
  hotInflation: { label: 'Hot inflation', fx: M(-1, -1, 0, -1, -1, -1, -1, 0) },
  coolInflation: { label: 'Cool inflation', fx: M(1, 1, 0, 1, 1, 1, 1, 0) },
  strongData: { label: 'Strong data', fx: M(1, -1, 1, -1, -1, -1, 0, 1) },
  weakData: { label: 'Weak data', fx: M(-1, 1, -1, 1, 1, 1, 0, -1) },
  escalation: { label: 'Getting worse', fx: M(-1, 1, 1, 1, 0, 1, -1, -1) },
  deescalation: { label: 'Calming down', fx: M(1, -1, -1, -1, 0, -1, 1, 1) },
  tariffsUp: { label: 'Tariffs up', fx: M(-1, 1, -1, 1, -1, 1, -1, -1) },
  tariffsDown: { label: 'Tariffs easing', fx: M(1, -1, 1, -1, 1, -1, 1, 1) },
  oilUp: { label: 'Less oil supply', fx: M(0, 0, 1, 0, 0, 0, 0, 0) },
  oilDown: { label: 'More oil supply', fx: M(0, 0, -1, 0, 0, 0, 0, 0) },
  usdUp: { label: 'Dollar bought', fx: M(0, -1, -1, 0, -1, -1, -1, -1) },
  usdDown: { label: 'Dollar sold', fx: M(0, 1, 1, 0, 1, 1, 1, 1) },
  yieldsUp: { label: 'Yields up', fx: M(-1, -1, 0, -1, -1, -1, -1, 0) },
  yieldsDown: { label: 'Yields down', fx: M(1, 1, 0, 1, 1, 1, 1, 0) },
  riskOn: { label: 'Risk on', fx: M(1, -1, 1, -1, 1, -1, 1, 1) },
  riskOff: { label: 'Risk off', fx: M(-1, 1, -1, 1, -1, 1, -1, -1) },
};
export const OPPOSITE = { hawkish: 'dovish', dovish: 'hawkish', hotInflation: 'coolInflation', coolInflation: 'hotInflation', strongData: 'weakData', weakData: 'strongData', escalation: 'deescalation', deescalation: 'escalation', tariffsUp: 'tariffsDown', tariffsDown: 'tariffsUp', oilUp: 'oilDown', oilDown: 'oilUp', usdUp: 'usdDown', usdDown: 'usdUp', yieldsUp: 'yieldsDown', yieldsDown: 'yieldsUp', riskOn: 'riskOff', riskOff: 'riskOn' };

/** +1 / 0 / −1: how this driver usually moves this market. Currency futures also react to their own country's news. */
export function impactOf(driver, market, ccy) {
  const d = DRIVERS[driver], m = NEWS_MARKETS[market];
  if (!d || !m) return 0;
  if (ccy && ccy !== 'USD') { // another country's data or central bank: moves its own currency, little else
    if (m.ccy !== ccy) return 0;
    const own = { hawkish: 1, hotInflation: 1, strongData: 1, dovish: -1, coolInflation: -1, weakData: -1 }[driver];
    return own ?? 0;
  }
  return d.fx[m.cls] || 0;
}

// the steps from the headline to the market, per driver and class of market
const UP = '▲', DN = '▼';
const CHAINS = {
  hawkish: { equity: ['Rates stay high', 'Borrowing costs more', 'Stocks worth less today'], gold: ['Rates stay high', 'Bonds pay more', 'Gold pays nothing', 'Sell gold, buy yield'], bond: ['Rates stay high', 'Yields rise'], fx: ['Rates stay high', 'Dollar pays more', 'Dollar bought'], yen: ['US rates stay high', 'Dollar pays more than yen'], crypto: ['Rates stay high', 'Less easy money'], copper: ['Rates stay high', 'Slower growth'] },
  escalation: { equity: ['More war risk', 'Investors sell risk'], gold: ['More war risk', 'Safe-haven buying'], oil: ['More war risk', 'Supply at risk'], bond: ['More war risk', 'Safe-haven buying'], yen: ['More war risk', 'Safe-haven buying'], crypto: ['More war risk', 'Investors sell risk'], copper: ['More war risk', 'Growth worries'] },
  tariffsUp: { equity: ['Higher costs', 'Lower profits, slower trade'], gold: ['Trade uncertainty', 'Safe-haven buying'], oil: ['Slower trade', 'Less demand'], bond: ['Growth worries', 'Safe-haven buying'], fx: ['Trade uncertainty', 'Dollar bought'], yen: ['Trade uncertainty', 'Safe-haven buying'], crypto: ['Trade uncertainty', 'Investors sell risk'], copper: ['Slower trade', 'Less demand'] },
  hotInflation: { equity: ['Prices rising faster', 'Fed cuts less', 'Rates stay high'], gold: ['Prices rising faster', 'Fed cuts less', 'Bonds pay more', 'Gold pays nothing'], bond: ['Prices rising faster', 'Fed cuts less', 'Yields rise'], fx: ['Fed cuts less', 'Dollar bought'], yen: ['Fed cuts less', 'Dollar bought'], crypto: ['Fed cuts less', 'Less easy money'] },
  strongData: { equity: ['Economy strong', 'Better profits'], gold: ['Economy strong', 'Fed cuts less', 'Dollar bought'], oil: ['Economy strong', 'More demand'], bond: ['Economy strong', 'Yields rise'], fx: ['Economy strong', 'Dollar bought'], yen: ['Economy strong', 'Dollar bought'], copper: ['Economy strong', 'More demand'] },
  oilUp: { oil: ['Less supply', 'Tighter market'] },
  usdUp: { gold: ['Dollar stronger', 'Gold costs more abroad'], oil: ['Dollar stronger', 'Oil costs more abroad'], fx: ['Dollar bought'], yen: ['Dollar bought'], crypto: ['Dollar stronger'], copper: ['Dollar stronger', 'Metals cost more abroad'] },
  yieldsUp: { equity: ['Yields rise', 'Stocks worth less today'], gold: ['Yields rise', 'Bonds pay more', 'Gold pays nothing'], bond: ['Yields rise'], fx: ['US yields rise', 'Dollar bought'], yen: ['US yields rise', 'Dollar bought'], crypto: ['Yields rise', 'Less easy money'] },
  riskOn: { equity: ['Investors buy risk'], gold: ['Less need for safety'], oil: ['Growth hopes'], bond: ['Less need for safety'], fx: ['Dollar sold'], yen: ['Less need for safety'], crypto: ['Investors buy risk'], copper: ['Growth hopes'] },
};
const FLIP = { 'Rates stay high': 'Rate cuts back in play', 'Borrowing costs more': 'Borrowing gets cheaper', 'Stocks worth less today': 'Stocks worth more today', 'Bonds pay more': 'Bonds pay less', 'Gold pays nothing': 'Gold looks better', 'Sell gold, buy yield': 'Buy gold', 'Yields rise': 'Yields fall', 'Dollar pays more': 'Dollar pays less', 'Dollar bought': 'Dollar sold', 'US rates stay high': 'US rates fall', 'Dollar pays more than yen': 'Dollar pays less', 'Less easy money': 'More easy money', 'Slower growth': 'Faster growth', 'More war risk': 'Less war risk', 'Investors sell risk': 'Investors buy risk', 'Safe-haven buying': 'Safe havens sold', 'Supply at risk': 'Supply flows', 'Growth worries': 'Growth hopes', 'Higher costs': 'Lower costs', 'Lower profits, slower trade': 'Better profits, more trade', 'Trade uncertainty': 'Trade calming', 'Slower trade': 'More trade', 'Less demand': 'More demand', 'Prices rising faster': 'Prices rising slower', 'Fed cuts less': 'Fed cuts more', 'Economy strong': 'Economy weak', 'Better profits': 'Weaker profits', 'More demand': 'Less demand', 'Less supply': 'More supply', 'Tighter market': 'Looser market', 'Dollar stronger': 'Dollar weaker', 'Gold costs more abroad': 'Gold cheaper abroad', 'Oil costs more abroad': 'Oil cheaper abroad', 'Metals cost more abroad': 'Metals cheaper abroad', 'US yields rise': 'US yields fall', 'Investors buy risk': 'Investors sell risk', 'Less need for safety': 'More need for safety', 'Growth hopes': 'Growth worries', 'Dollar sold': 'Dollar bought' };
/** ["Hawkish", "Rates stay high", …, "Gold ▼"] — empty when this driver doesn't usually move this market. */
export function chainFor(driver, market) {
  const m = NEWS_MARKETS[market];
  const dir = impactOf(driver, market);
  if (!m || !dir) return [];
  const base = CHAINS[driver] ? driver : OPPOSITE[driver];
  const steps = (CHAINS[base]?.[m.cls] || []).map((s) => (base === driver ? s : FLIP[s] || s));
  return [DRIVERS[driver].label, ...steps, `${m.short} ${dir > 0 ? UP : DN}`];
}

// ---------- reading a headline ----------
const re = (s) => new RegExp(s, 'i');
const FED = re("\\b(fed|fomc|powell|federal reserve|waller|williams|goolsbee|bowman|barr|jefferson|daly|hammack|logan|kashkari|musalem|schmid|bostic|lisa cook|collins|harker|paulson|miran|warsh|hassett|beige book)\\b");
const OTHER_CB = [['ECB', 'EUR', re('\\b(ecb|lagarde|european central bank|schnabel|lane)\\b')], ['BOJ', 'JPY', re('\\b(boj|bank of japan|ueda|himino)\\b')], ['BOE', 'GBP', re('\\b(boe|bank of england|bailey)\\b')], ['RBA', 'AUD', re('\\b(rba|reserve bank of australia|bullock)\\b')], ['BOC', 'CAD', re('\\b(boc|bank of canada|macklem)\\b')]];
const DATA = re('\\b(cpi|ppi|pce|inflation|consumer prices|producer prices|payrolls?|nfp|jobs report|nonfarm|unemployment|jobless claims|initial claims|gdp|retail sales|ism|pmi|consumer confidence|consumer sentiment|durable goods|housing starts|building permits|jolts|job openings|adp|industrial production|core prices|wages|earnings growth)\\b');
const TRUMP = re('\\b(trump|white house|truth social|president of the united states|executive order)\\b');
const WAR = re('\\b(war|wars|missile|airstrike|air strike|strikes on|attack|troops|invasion|invade|ceasefire|truce|sanction|iran|israel|gaza|hamas|hezbollah|houthi|yemen|ukraine|russia|putin|zelensky|kremlin|hormuz|red sea|taiwan|north korea|nato|venezuela|military|drone|nuclear)\\b');
const TRADE = re('\\b(tariffs?|trade deal|trade war|trade talks|export controls?|import dut(y|ies)|trade truce|customs duties|section 232|section 301)\\b');
const ENERGY = re('\\b(oil|crude|opec|brent|wti|gasoline|eia|refiner|natural gas|lng|barrels?|rig count)\\b');
const RATES = re('\\b(treasur(y|ies)|yields?|bonds?|bills? auction|note auction|bond auction|2-year|10-year|30-year)\\b');
const FXW = re('\\b(dollar|usd|dxy|euro|yen|sterling|yuan|currenc(y|ies))\\b');
const STOCKS = re('\\b(earnings|eps|revenue|guidance|shares|stocks|equities|nasdaq|s&p|dow|nvidia|apple|microsoft|tesla|amazon|meta|alphabet|google|broadcom)\\b');
const CRYPTO = re('\\b(bitcoin|btc|crypto|ether|ethereum|stablecoin)\\b');
const METALS = re('\\b(gold|silver|bullion|precious metals|copper)\\b');

const STORIES = [ // first match wins; [key, title, test]
  ['fed', 'The Fed', FED],
  ['ecb', 'The ECB', OTHER_CB[0][2]], ['boj', 'The Bank of Japan', OTHER_CB[1][2]], ['boe', 'The Bank of England', OTHER_CB[2][2]],
  ['iran', 'Iran', re('\\b(iran|tehran|hormuz)\\b')],
  ['middle-east', 'Israel and Gaza', re('\\b(israel|gaza|hamas|hezbollah|lebanon|houthi|yemen|red sea)\\b')],
  ['russia-ukraine', 'Russia and Ukraine', re('\\b(ukraine|russia|putin|zelensky|kremlin|kyiv|moscow)\\b')],
  ['china', 'US and China', re('\\b(china|chinese|beijing|xi jinping|xi)\\b')],
  ['tariffs', 'Tariffs and trade', TRADE],
  ['venezuela', 'Venezuela', re('\\bvenezuela')],
  ['taiwan', 'Taiwan', re('\\btaiwan')],
  ['opec', 'OPEC and oil supply', re('\\b(opec|saudi|output cut|production cut)\\b')],
  ['oil-stocks', 'Oil inventories', re('\\b(eia|api|inventor(y|ies)|crude stocks|stockpiles?|rig count)\\b')],
  ['inflation', 'Inflation', re('\\b(cpi|ppi|pce|inflation|core prices|consumer prices|producer prices)\\b')],
  ['jobs', 'Jobs', re('\\b(payrolls?|nfp|jobs report|nonfarm|unemployment|jobless|claims|jolts|job openings|adp|layoffs?)\\b')],
  ['growth', 'Growth', re('\\b(gdp|retail sales|ism|pmi|consumer (confidence|sentiment)|durable goods|industrial production|housing)\\b')],
  ['shutdown', 'Government funding', re('\\b(shutdown|debt ceiling|funding bill|continuing resolution)\\b')],
  ['treasuries', 'Treasuries', RATES],
  ['big-tech', 'Big tech', re('\\b(nvidia|apple|microsoft|tesla|amazon|meta|alphabet|google|broadcom|openai)\\b')],
  ['earnings', 'Earnings', re('\\b(earnings|eps|guidance|quarterly results)\\b')],
  ['crypto', 'Crypto', CRYPTO],
  ['trump', 'Trump', TRUMP],
];

const NEG_BEFORE_CUT = re('\\b(no|fewer|less|delay(s|ed|ing)?|against|not|pause|skip|premature|unlikely|reduced?)\\b[^.]{0,30}\\b(rate )?cuts?\\b');
const HAWK = re("\\b(hawkish|rate hikes?|hike rates|raise rates|raising rates|higher for longer|tighten(ing)?|no rush|in no hurry|patient|inflation (remains|is|still) (elevated|sticky|too high|above)|upside risks? to inflation|restrictive for longer|not (yet )?(time|appropriate) to cut|unexpectedly (holds|raises)|(raises|hikes) (its |the )?(key |benchmark )?(rates?|interest))\\b");
const DOVE = re("\\b(dovish|rate cuts?|cut rates|cutting rates|lower rates|easing|cuts? (is|are|remain) (on the table|appropriate|likely|coming)|labor market (is )?(weakening|softening|cooling)|downside risks|support (a|further) cut|room to cut|more cuts)\\b");
const ESC = re("\\b(attack(s|ed)?|strikes? (on|at|against)|airstrikes?|missiles?|escalat\\w*|invade[sd]?|invasion|threat(en)?s?|warns?|retaliat\\w*|blockade|seize[sd]?|explosions?|drones?|killed|troops|mobiliz\\w*|new sanctions|sanctions (on|against)|clos(e|es|ed|ing) (the )?(strait|hormuz)|getting worse|tensions? (rise|rising|escalate)|shoot down|shot down|bomb\\w*)\\b");
const DEESC = re("\\b(ceasefire|cease-fire|truce|peace|talks|deal|agreement|de-?escalat\\w*|withdraw\\w*|return to normal|resume[sd]?|calm\\w*|negotiat\\w*|lift(s|ed|ing)? sanctions|ease[sd]? sanctions|sign (a|the) deal|hostages? (freed|released)|reopen\\w*)\\b");
const TUP = re("\\b((impose[sd]?|raise[sd]?|hike[sd]?|new|additional|higher|threaten\\w*|slap\\w*)\\b[^.]{0,30}\\btariffs?|tariffs? (of|on) \\d+%|\\d+% tariffs?|tariffs? (hike|increase)|trade war)\\b");
const TDOWN = re("\\b((pause[sd]?|delay\\w*|exempt\\w*|lower\\w*|cut[s]?|remove[sd]?|suspend\\w*|lift\\w*|roll(s|ed)? back|scrap\\w*|reduce[sd]?)\\b[^.]{0,30}\\btariffs?|tariffs?\\b[^.]{0,30}\\b(paused|delayed|exempt\\w*|cut|lifted|suspended|reduced|rolled back)|trade (deal|truce|agreement))\\b");
const OILUP = re("\\b(opec\\+? (agrees? to |)(cut|reduce)\\w*|output cuts?|production cuts?|supply disruptions?|outages?|crude (draw|stocks fall)|inventor(y|ies) (draw|fall|fell|drop)|stockpiles? (fall|fell|drop)|draws?|pipeline (attack|shut)|refinery (fire|attack)|hormuz)\\b");
const OILDN = re("\\b(opec\\+? (agrees? to |)(raise|increase|boost)\\w*|output (hike|increase)s?|production (hike|increase)s?|crude (build|stocks rise)|inventor(y|ies) (build|rise|rose)|stockpiles? (rise|rose)|builds?|glut|oversuppl\\w*)\\b");
const USDUP = re('\\b(dollar|usd|dxy|greenback)\\b[^.]{0,25}\\b(rises?|gains?|jumps?|strengthens?|firms?|rall(y|ies)|bought|climbs?|surges?|higher)\\b');
const USDDN = re('\\b(dollar|usd|dxy|greenback)\\b[^.]{0,25}\\b(falls?|fell|slips?|weakens?|drops?|sold|slides?|declines?|lower|sinks?)\\b');
const YUP = re('\\b(yields?)\\b[^.]{0,25}\\b(rise|rises|rose|jump|jumps|climb|climbs|surge|surges|higher|spike)\\b');
const YDN = re('\\b(yields?)\\b[^.]{0,25}\\b(fall|falls|fell|drop|drops|slide|slides|lower|ease|eases|eased)\\b');
const RON = re('\\b(stocks|equities|s&p|nasdaq|dow|futures|wall street)\\b[^.]{0,30}\\b(rall(y|ies)|surge|surges|jump|jumps|record high|rise|rises|gain|gains|climb|climbs)\\b');
const ROFF = re('\\b(stocks|equities|s&p|nasdaq|dow|futures|wall street)\\b[^.]{0,30}\\b(fall|falls|fell|slide|slides|tumble|tumbles|plunge|plunges|drop|drops|sell-?off|sink|sinks|slump)\\b');
const ABOVE = re('\\b(above|beats?|tops?|higher than|hotter than|stronger than)\\b[^.]{0,25}\\b(forecasts?|expected|expectations|estimates?|consensus|f\\/?c)\\b|\\bvs\\.? ?(exp|est|f\\/?c)|\\(exp');
const BELOW = re('\\b(below|misses?|missed|lower than|cooler than|weaker than|softer than)\\b[^.]{0,25}\\b(forecasts?|expected|expectations|estimates?|consensus)\\b');
const INFL = re('\\b(cpi|ppi|pce|inflation|prices|core)\\b');
const LOWER_IS_BETTER = /unemploy|jobless|claims|claimant|layoff|job cuts|challenger|bankrupt|deficit/i;

/** "0.4% vs 0.3% expected" / "rises 0.4%, above the 0.3% forecast" → { actual, forecast } */
function numbersVs(t) {
  const m = /(-?\d+(?:\.\d+)?)\s*(%|k|m|b)?\b[^\d]{0,40}?\b(?:vs\.?|versus|against|forecast|expected|exp\.?|est\.?|consensus)\b[^\d-]{0,20}(-?\d+(?:\.\d+)?)/i.exec(t)
    || /(-?\d+(?:\.\d+)?)\s*(%|k|m|b)?[^.\d]{0,30}\b(?:above|below|beat|missed?|topped)\b[^\d-]{0,25}(-?\d+(?:\.\d+)?)/i.exec(t);
  if (!m) return null;
  const a = Number(m[1]), f = Number(m[3] ?? m[4]);
  return Number.isFinite(a) && Number.isFinite(f) && a !== f ? { actual: a, forecast: f } : null;
}

/** Data drivers from a release: kind (inflation / jobs / growth), actual vs forecast. ccy: whose data. */
export function dataDriver(title, actual, forecast) {
  if (actual == null || forecast == null || actual === forecast) return null;
  const higher = actual > forecast;
  if (INFL.test(title) && !/expectations? (index|survey)/i.test(title)) return higher ? 'hotInflation' : 'coolInflation';
  const better = LOWER_IS_BETTER.test(title) ? !higher : higher;
  return better ? 'strongData' : 'weakData';
}

/**
 * Read one headline. → { cats, story, storyTitle, driver, tone, importance (1–3), ccy, surprise? }
 * text: the headline (plus a short summary if there is one); src: the feed's id.
 */
export function classify(text, { src = '' } = {}) {
  const t = ` ${String(text || '').replace(/\s+/g, ' ')} `;
  const cats = [];
  let ccy = 'USD';
  const cb = OTHER_CB.find(([, , r]) => r.test(t));
  if (FED.test(t) || src.startsWith('fed')) cats.push('fed');
  else if (cb) { cats.push('cb'); ccy = cb[1]; }
  if (DATA.test(t) || src === 'bls' || src === 'calendar') cats.push('data');
  if (TRUMP.test(t) || src === 'truth' || src === 'whitehouse') cats.push('trump');
  if (WAR.test(t)) cats.push('wars');
  if (TRADE.test(t)) cats.push('trade');
  if (ENERGY.test(t)) cats.push('energy');
  if (RATES.test(t)) cats.push('rates');
  if (FXW.test(t)) cats.push('fx');
  if (METALS.test(t)) cats.push('metals');
  if (STOCKS.test(t)) cats.push('stocks');
  if (CRYPTO.test(t)) cats.push('crypto');
  const st = STORIES.find(([, , r]) => r.test(t)) || (src === 'truth' ? STORIES.find((s) => s[0] === 'trump') : null);
  let driver = null;
  if (cats.includes('fed') || cats.includes('cb')) {
    const negCut = NEG_BEFORE_CUT.test(t);
    if (negCut || HAWK.test(t)) driver = 'hawkish';
    else if (DOVE.test(t)) driver = 'dovish';
  }
  let surprise = null;
  if (!driver && cats.includes('data')) {
    const n = numbersVs(t);
    const above = ABOVE.test(t), below = BELOW.test(t);
    if (n) { surprise = n; driver = dataDriver(t, n.actual, n.forecast); }
    else if (above || below) driver = dataDriver(t, above ? 1 : 0, above ? 0 : 1);
  }
  if (!driver && (cats.includes('wars') || st?.[0] === 'iran' || st?.[0] === 'middle-east' || st?.[0] === 'russia-ukraine')) {
    const e = ESC.test(t), d = DEESC.test(t);
    if (e && !d) driver = 'escalation';
    else if (d && !e) driver = 'deescalation';
    else if (d && e) driver = /\b(ceasefire|truce|peace|deal)\b/i.test(t) ? 'deescalation' : 'escalation';
  }
  if (!driver && cats.includes('trade')) driver = TDOWN.test(t) ? 'tariffsDown' : TUP.test(t) ? 'tariffsUp' : null;
  if (!driver && cats.includes('energy')) driver = OILUP.test(t) ? 'oilUp' : OILDN.test(t) ? 'oilDown' : null;
  if (!driver && YUP.test(t)) driver = 'yieldsUp';
  if (!driver && YDN.test(t)) driver = 'yieldsDown';
  if (!driver && USDUP.test(t)) driver = 'usdUp';
  if (!driver && USDDN.test(t)) driver = 'usdDown';
  if (!driver && RON.test(t)) driver = 'riskOn';
  if (!driver && ROFF.test(t)) driver = 'riskOff';
  // how much it matters
  let importance = 1;
  if (/\b(breaking|urgent|flash)\b/i.test(t)) importance = 3;
  if ((cats.includes('fed') || cats.includes('cb')) && /\b(decision|holds|raises|cuts|leaves) (its |the )?(key |benchmark |policy )?(rates?|interest)|statement|press conference|minutes\b/i.test(t)) importance = 3;
  else if ((cats.includes('fed') || cats.includes('cb')) && driver) importance = Math.max(importance, 2);
  if (cats.includes('data') && (surprise || driver)) importance = Math.max(importance, /\b(cpi|payrolls|nfp|nonfarm|pce|gdp)\b/i.test(t) ? 3 : 2);
  if (cats.includes('wars') && driver) importance = Math.max(importance, 2);
  if (cats.includes('trade') && driver) importance = Math.max(importance, cats.includes('trump') ? 3 : 2);
  if (cats.includes('energy') && driver) importance = Math.max(importance, 2);
  if (cats.includes('trump') && (cats.includes('trade') || cats.includes('wars') || cats.includes('fed'))) importance = Math.max(importance, 2);
  // routine lines: repeats of statements, scheduled notices
  const filler = /\b(due at|scheduled|preview|what to watch|explainer|live updates?|recap|week ahead|factbox)\b/i.test(t) || (cats.includes('fed') && !driver && /^\s*(fed|fomc)\s*:/i.test(t));
  if (filler) importance = 1;
  return { cats, story: st?.[0] || 'other', storyTitle: st?.[1] || 'Other news', driver, tone: driver ? DRIVERS[driver].label : null, importance, ccy, surprise, filler };
}

/** Per-market impact of a classified line: { ES: -1, GC: 1, … } (only the markets asked for, zeros left out). */
export function impactsFor(c, markets) {
  const out = {};
  if (!c?.driver) return out;
  for (const m of markets) { const v = impactOf(c.driver, m, c.ccy); if (v) out[m] = v; }
  return out;
}

// ---------- similar lines (for folding repeats) ----------
const STOP = new Set('the a an of to in on for and or at by with from as is are be was were it its this that will says say said after over new us u.s. vs amid into up down more than'.split(' '));
export const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
export function similarity(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
