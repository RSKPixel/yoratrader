import { useEffect } from "react";

export function InfoButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[#2c313a] text-[#9b968c] hover:border-[#e2c08a]/60 hover:text-[#e2c08a]"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="4" r="1.1" />
        <rect x="7" y="6.5" width="2" height="6.5" rx="1" />
      </svg>
    </button>
  );
}

export default function ModelInfoModal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#2c313a] bg-[#12151a] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2c313a] px-5 py-3">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-[#2c313a] px-2 py-0.5 text-sm text-[#c8c3b8] hover:bg-white/5"
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 text-sm leading-relaxed text-[#c8c3b8]">{children}</div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 text-xs uppercase tracking-[0.14em] text-[#e2c08a]">{title}</h3>
      {children}
    </section>
  );
}

function List({ children }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-[#6f6a62]">{children}</ul>;
}

const B = ({ children }) => <span className="text-[#e7e4dc]">{children}</span>;

function DataSection({ volume = false, continuous = false }) {
  return (
    <Section title="Data required">
      <List>
        <li>
          <B>15-minute candles</B> (table <code>intraday_15m</code>): OHLC{volume ? " and volume" : ""} for every symbol in
          the universe. Download them with the <B>iData</B> button on the contracts page, which fetches from the previous
          expiry or the last 7 days, whichever is shorter. <B>Rescan</B> on this page downloads today's candles first.
          History builds up with each download, and only days with 15m candles can be backtested.
        </li>
        {continuous && (
          <li>
            <B>Unbroken 15m history</B>: swings and Dow structure run over the symbol's whole 15m series, across days, so
            a missing day or missing candles change the swings and key breaks that follow.
          </li>
        )}
        <li>
          <B>Daily EOD candles</B> (table <code>eod</code>): high, low and close, from <B>Download EOD</B>. The trend
          filter needs at least <B>51 daily bars</B> (SMA50 plus the previous day) and the ATR needs 15. Days without
          enough daily history are skipped.
        </li>
        {volume && (
          <li>
            <B>Volume history</B>: the volume filter averages the previous 20 15m candles (at least 5), so a symbol's
            first downloaded candles can't trigger entries.
          </li>
        )}
        <li>
          <B>Kite login</B>: downloads use the Kite access token, which expires every day. Log in once a day in Settings.
        </li>
        <li>
          <B>Contract list</B>: lot sizes come from the front-month contracts and are used for the Net profit column.
          Kite reports MCX lot size as 1, so MCX trades show no rupee profit.
        </li>
      </List>
    </Section>
  );
}

function DailyContextSection() {
  return (
    <Section title="Before the open">
      <p className="mb-2">Each day uses only information known at the open (the previous day's close):</p>
      <List>
        <li>
          <B>Trend</B>: up if the previous close was above its 50-day SMA, otherwise down. Longs only in an uptrend,
          shorts only in a downtrend.
        </li>
        <li>
          <B>ATR(14)</B>: 14-day average true range up to the previous day.
        </li>
      </List>
    </Section>
  );
}

function UniverseSection({ perDay }) {
  return (
    <Section title="Universe and daily cap">
      <List>
        <li>
          <B>Index</B>: NIFTY, BANKNIFTY and MIDCPNIFTY futures. Other indices have too many zero-volume 15m candles to be
          useful. <B>NSE</B>, <B>MCX</B> and <B>All</B> scan every front-month contract.
        </li>
        <li>{perDay}</li>
        <li>
          <B>N/day</B> keeps the first N trades each day across the whole universe, in order of entry time. Ties on the
          same candle go to the tighter stop (risk as a percent of price).
        </li>
      </List>
    </Section>
  );
}

function ResultsSection({ t1 }) {
  return (
    <Section title="Reading the results">
      <List>
        <li>
          <B>R</B>: result in risk units, before costs. A trade that reaches T1 books half at {t1}, and the other half
          adds its own result.
        </li>
        <li>
          <B>Points</B>: R × risk, the price move per unit.
        </li>
        <li>
          <B>Net profit</B>: one lot, after Zerodha brokerage (0.03% per order, capped at ₹20), STT, exchange, SEBI,
          stamp duty and GST. A T1 exit counts as two orders. Hover the cell for the breakdown.
        </li>
        <li>
          Fills are assumed exact: stops fill at the stop price, with no slippage. If one candle touches both stop and
          target, the stop is assumed to come first.
        </li>
      </List>
    </Section>
  );
}

function SessionTimes() {
  return (
    <>
      No new entries after the candle starting <B>13:30</B> on NSE or <B>20:00</B> on MCX
    </>
  );
}

export function OrbInfo() {
  return (
    <>
      <Section title="Idea">
        <p>
          The first 30 minutes of a session set the day's opening range. When price closes outside that range in the
          direction of the daily trend, with volume and VWAP agreeing, the model takes one trade and manages it to the
          end of the session. It is long-only in an uptrend and short-only in a downtrend.
        </p>
      </Section>

      <DataSection volume />

      <DailyContextSection />

      <Section title="Opening range">
        <List>
          <li>
            High and low of the <B>first two 15m candles</B>: 9:15–9:45 on NSE, 9:00–9:30 on MCX.
          </li>
          <li>
            The day is skipped if the range is <B>wider than 1.0× ATR</B> (the move already happened) or{" "}
            <B>narrower than 0.2× ATR</B> (too tight to mean anything).
          </li>
        </List>
      </Section>

      <Section title="Entry">
        <p className="mb-2">On the close of any later 15m candle, at most once per symbol per day:</p>
        <List>
          <li>
            <B>Long</B> (uptrend): close above the range high <B>and</B> above session VWAP.
          </li>
          <li>
            <B>Short</B> (downtrend): close below the range low <B>and</B> below session VWAP.
          </li>
          <li>
            The candle's volume must be <B>above its 20-candle average</B>.
          </li>
          <li>
            No new entries after the candle starting <B>13:30</B> on NSE or <B>20:00</B> on MCX.
          </li>
          <li>Entry price is that candle's close. VWAP uses the typical price (H+L+C)/3, reset each session.</li>
        </List>
      </Section>

      <Section title="Stop and target">
        <List>
          <li>
            <B>Stop</B>: the tighter of the opposite side of the range and entry ∓ <B>0.5× ATR</B>.
          </li>
          <li>
            <B>Risk (1R)</B> = |entry − stop|. <B>T1</B> = entry ± 1R.
          </li>
        </List>
      </Section>

      <Section title="Managing the trade">
        <List>
          <li>
            Stop hit before T1: full loss of <B>−1R</B> (exit reason <code>stop</code>).
          </li>
          <li>
            T1 hit: <B>half is booked at +1R</B> and the stop moves to entry (breakeven).
          </li>
          <li>
            After T1, the stop trails the <B>low (long) or high (short) of the last two candles</B> and only moves in the
            trade's favour (exit reason <code>trail</code>).
          </li>
          <li>
            Anything still open is closed at the close of the candle starting <B>15:15</B> on NSE or <B>23:00</B> on MCX
            (<code>time</code>), or at the last candle if the session ended earlier (<code>session end</code>).
          </li>
          <li>Today's trades that haven't exited yet show as open, marked to the latest candle.</li>
        </List>
      </Section>

      <UniverseSection perDay="One trade per symbol per day." />

      <ResultsSection t1="+1R" />
    </>
  );
}

export function FibInfo() {
  return (
    <>
      <Section title="Idea">
        <p>
          A strong opening drive in the direction of the daily trend often pulls back to the 50–61.8% Fibonacci zone
          before it continues. The model waits for that pullback and buys (or sells) the first candle that turns back
          in the trend direction, aiming for a retest of the drive's high and then the 127.2% extension.
        </p>
      </Section>

      <DataSection />

      <DailyContextSection />

      <Section title="Opening drive (impulse)">
        <p className="mb-2">Described for longs; shorts are the mirror image.</p>
        <List>
          <li>
            <B>Impulse low</B>: the session's lowest low up to the candle starting <B>10:30</B> on NSE or <B>10:15</B> on
            MCX.
          </li>
          <li>
            <B>Impulse high</B>: the highest high after that low. It keeps extending until the pullback starts.
          </li>
          <li>
            The impulse (high − low) must be at least <B>0.6× ATR</B> before a pullback counts.
          </li>
          <li>Fib levels are measured on this leg: 0% at the high, 100% at the low.</li>
        </List>
      </Section>

      <Section title="Pullback and entry">
        <List>
          <li>
            The pullback starts when a candle after the high trades down to the <B>50% retracement</B>.
          </li>
          <li>
            The setup <B>fails</B> if any candle closes below <B>78.6%</B> before entry.
          </li>
          <li>
            <B>Entry</B>: the first green candle (close above open) that closes <B>above the previous candle's high</B>{" "}
            and still below the impulse high. Entry price is that candle's close.
          </li>
          <li>
            <SessionTimes />. There is no volume or VWAP filter.
          </li>
        </List>
      </Section>

      <Section title="Stop and targets">
        <List>
          <li>
            <B>Stop</B>: the lower of the 78.6% level and the pullback low. Risk (1R) = entry − stop.
          </li>
          <li>
            <B>T1</B>: the impulse high. Half is booked and the stop moves to entry (breakeven).
          </li>
          <li>
            <B>T2</B>: the <B>127.2% extension</B> of the impulse closes the other half.
          </li>
        </List>
      </Section>

      <Section title="Managing the trade">
        <List>
          <li>
            Stop hit before T1: full loss of <B>−1R</B> (<code>stop</code>). After T1, the breakeven stop closes the rest at
            entry (<code>trail</code>).
          </li>
          <li>There is no trailing stop; after T1 the stop stays at entry until T2 or the session exit.</li>
          <li>
            Anything still open is closed at the close of the candle starting <B>15:15</B> on NSE or <B>23:00</B> on MCX
            (<code>time</code>), or at the last candle if the session ended earlier (<code>session end</code>).
          </li>
          <li>Today's trades that haven't exited yet show as open, marked to the latest candle.</li>
        </List>
      </Section>

      <UniverseSection perDay="One trade per symbol per day." />

      <ResultsSection t1="the impulse high" />
    </>
  );
}

export function KbdtFibInfo() {
  return (
    <>
      <Section title="Idea">
        <p>
          Dow theory on 15m swings decides direction: a <B>key break</B> (price taking out the last Dow peak or trough)
          says the trend has turned. Fibonacci decides timing: instead of buying the break, the model waits for a
          pullback into the break leg and enters when price turns back. It uses the same swing and Dow tools as the Key
          Breakout Dow Theory page, run on 15m candles instead of daily ones.
        </p>
      </Section>

      <DataSection continuous />

      <DailyContextSection />

      <Section title="Key break and leg">
        <p className="mb-2">Described for longs; shorts are the mirror image.</p>
        <List>
          <li>
            <B>Swings</B>: bars are classed as directional, inside or outside bars, and swing highs and lows are marked
            from them (SwingPoints2). Dow structure (ddt2) tracks the current peak or trough from those swings.
          </li>
          <li>
            <B>Key break up</B>: a candle trades above the last Dow peak. It only counts if the daily trend is up and the
            break candle starts no later than <B>13:30</B> on NSE or <B>20:00</B> on MCX.
          </li>
          <li>
            <B>Leg low</B>: the lowest low since the previous opposite (down) key break, or over the last 40 candles if
            there isn't one. It can be on an earlier day.
          </li>
          <li>
            <B>Leg high</B>: the high of the break candle, extended by any higher highs until the pullback starts.
          </li>
          <li>Fib levels are measured on this leg: 0% at the high, 100% at the low.</li>
        </List>
      </Section>

      <Section title="Pullback and entry">
        <List>
          <li>
            The pullback starts when a candle trades down to the <B>38.2% retracement</B>. At that point the leg must be
            at least <B>0.4× ATR</B>, otherwise the setup is dropped (<code>small_leg</code>).
          </li>
          <li>
            The setup <B>fails</B> on a close below <B>78.6%</B> or on an opposite key break before entry.
          </li>
          <li>
            <B>Entry</B>: the first green candle that closes <B>above the previous candle's high</B> and still below the
            leg high. Entry price is that candle's close.
          </li>
          <li>
            Entry must come on the same day as the key break. <SessionTimes />.
          </li>
        </List>
      </Section>

      <Section title="Stop and targets">
        <List>
          <li>
            <B>Stop</B>: the lower of the 78.6% level and the pullback low. Risk (1R) = entry − stop.
          </li>
          <li>
            <B>T1</B>: the leg high (100%). Half is booked and the stop moves to entry (breakeven).
          </li>
          <li>
            <B>T2</B>: the <B>161.8% extension</B> of the leg closes the other half.
          </li>
        </List>
      </Section>

      <Section title="Managing the trade">
        <List>
          <li>
            Stop hit before T1: full loss of <B>−1R</B> (<code>stop</code>). After T1, the breakeven stop closes the rest at
            entry (<code>trail</code>).
          </li>
          <li>
            An <B>opposite key break</B> closes everything at that candle's close (<code>key break</code>).
          </li>
          <li>
            Anything still open is closed at the close of the candle starting <B>15:15</B> on NSE or <B>23:00</B> on MCX
            (<code>time</code>), or at the last candle if the session ended earlier (<code>session end</code>).
          </li>
          <li>Today's trades that haven't exited yet show as open, marked to the latest candle.</li>
        </List>
      </Section>

      <Section title="Caveat">
        <p>
          A swing is only known once later candles confirm it, but the history marks it on its own candle. Key-break
          levels in the backtest are therefore slightly better than they would have been live.
        </p>
      </Section>

      <UniverseSection perDay="One trade per key break, so a symbol can trade more than once a day." />

      <ResultsSection t1="the leg high" />
    </>
  );
}

export function BacktestInfo() {
  return (
    <>
      <Section title="What it tests">
        <p className="mb-2">
          The live KBDT scanner, run day by day over 15m candles: <B>since 2015 for the F&amp;O indices</B> (as far back as Kite has them) and the <B>last 5 years for the stocks</B>:
        </p>
        <List>
          <li>
            <B>Key Breakout Dow Theory</B>: signals from daily candles. Entry when price trades through the key-break
            level (at the level, or at the open if it gapped past); stop at the previous day's low (long) or high
            (short); exit at <B>15:15 on day 1, 3 or 5</B>, counting the entry day as day 1, unless stopped first. The
            15m candles give the exact entry time and stop checks. One open position per symbol.
          </li>
          <li>
            KBDT <B>stop</B> options: <B>Previous day</B> is the model. <B>Fixed</B> puts the stop 0.5–2% from the entry
            price instead, so every trade risks about the same. <B>Capped</B> keeps the model stop but never further than
            that %. With multi-day holds an overnight gap can still open beyond any stop; the exit is then at the open.
          </li>
          <li>
            KBDT is <B>replayed day by day</B>: each day's swings, Dow structure and weekly low-volatility filter are
            computed only from the 250 daily candles up to that day, as the live scanner would have seen them. Computing
            them once over the whole history would leak the future, because swing points are confirmed by later candles.
          </li>
          <li>
            The table at the bottom compares every exit and stop setting under the current dataset, cap and slippage.
          </li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>
            Kite keeps no intraday history for expired futures, so the backtest uses <B>NSE cash data</B> as a stand-in.
            It is stored in its own tables (<code>bt_15m</code>, <code>bt_daily</code>) and never mixes with the live
            futures data.
          </li>
          <li>
            <B>F&amp;O indices</B>: the five NSE indices with futures (NIFTY 50, NIFTY BANK, NIFTY FIN SERVICE, NIFTY MID
            SELECT, NIFTY NEXT 50), spot data standing in for their futures. 15m candles start where Kite's history
            does: January 2015 for NIFTY, BANK and FIN SERVICE, November 2015 for NEXT 50 and January 2022 for MID
            SELECT. Daily candles go back to 2000 for NIFTY and NEXT 50. Kite's early daily history for the others is
            closing prices only (open = high = low = close), which has no swings or stops, so it is ignored: real
            candles start in June 2005 for BANK, February 2012 for FIN SERVICE and January 2022 for MID SELECT.
          </li>
          <li>
            <B>Indices before their 15m history</B> (NIFTY and NEXT 50 from 2001, BANK from 2006, FIN SERVICE from 2013, to 2015) are simulated on <B>daily candles</B>: entry
            at the key-break level, or the open if it gapped past; a stop the entry day's range touches counts as hit
            (worst case, since the order within the day is unknown); later days check an opening gap, then the low or
            high; the time exit is the close of the last day instead of 15:15. These trades show "daily" as their
            entry time. Signals start after 250 daily candles of warm-up.
          </li>
          <li>
            <B>Nifty 50 stocks</B>: today's 50 constituents from niftyindices.com, cash market with volume, full model.
          </li>
          <li>
            For the stocks, daily candles start about 4 months before the first 15m day.
          </li>
          <li>
            <B>Update data</B> downloads only missing candles (new ones, and older history not yet stored), then reruns
            every setting (a few minutes).
          </li>
        </List>
      </Section>

      <Section title="Costs">
        <List>
          <li>
            <B>R</B> is before costs. <B>Net R</B> subtracts NSE futures charges and slippage, converted to R using each
            trade's own risk: STT 0.05% on the sell side, exchange 0.00173% and SEBI on both sides, stamp 0.002% on the
            buy side, ₹20 per order brokerage and 18% GST.
          </li>
          <li>
            Brokerage is turned into a percentage using an assumed one-lot value of ₹15 lakh for NIFTY and ₹7 lakh for a
            stock. It is a small part of the cost either way.
          </li>
          <li>
            <B>Slippage</B> is applied on both the entry and the exit, as a percent of price. 0.02% is a fair guess for
            NIFTY futures; liquid stock futures are often 0.02–0.05%.
          </li>
          <li>Charges use today's rates for the whole period (STT on futures was lower before April 2026).</li>
        </List>
      </Section>

      <Section title="Rupees">
        <List>
          <li>
            <B>₹ per lot</B> converts each trade's net R into rupees for one futures lot: R × the stop distance in points ×
            the lot size.
          </li>
          <li>
            It uses <B>today's lot sizes</B> (NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120, NIFTYNXT50 25, and each
            stock's current lot). Lot sizes changed over the years, so older trades are shown as if traded at today's
            size.
          </li>
          <li>
            Totals and drawdown assume one lot on every trade, including trades in different indices open at the same
            time.
          </li>
        </List>
      </Section>

      <Section title="Biases to keep in mind">
        <List>
          <li>
            <B>Survivorship</B>: the stock list is today's NIFTY 50. Stocks that dropped out over the 5 years are
            missing, and the ones that stayed tended to do well. This flatters the stock results.
          </li>
          <li>
            <B>Cash vs futures</B>: futures trade at a premium to cash, so live fills will differ a little.
          </li>
          <li>
            <B>Fills</B>: entries at the 15m candle close and stops exactly at the stop price. If one candle touches both
            stop and target, the stop is assumed to come first.
          </li>
          <li>
            <B>Cap</B>: with several stocks breaking out on the same candle, the cap keeps the tightest stops first. Tight
            stops make costs larger in R, so try 0.02–0.05% slippage before trusting a cap setting.
          </li>
        </List>
      </Section>

      <Section title="Reading the page">
        <List>
          <li>
            <B>Profit factor</B>: net winning R ÷ net losing R. Above 1 makes money; 1.2+ starts to be interesting.
          </li>
          <li>
            <B>Max drawdown</B>: the largest fall in cumulative net R from a peak. Hover it for the t-stat; above about 2
            means the average result is unlikely to be luck.
          </li>
          <li>
            <B>Net R by month</B>: green and red cells, darker for bigger months. Click one to list its trades.
          </li>
        </List>
      </Section>
    </>
  );
}

export function GapBacktestInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Ernest Chan's <B>buy-on-gap</B> (Algorithmic Trading: Winning Strategies and Their Rationale, ch. 4), pure
          intraday:
        </p>
        <List>
          <li>
            <B>Buy at the 09:15 open</B> when a stock opens below the previous day's low by more than <B>1σ</B>, the
            standard deviation of its last 90 daily close-to-close returns.
          </li>
          <li>
            Only if the open is still <B>above its 20-day average close</B>: a dip in an uptrend, not a collapse.
          </li>
          <li>
            Each day, take the <B>biggest gaps across the dataset</B> (top 5 or 10) and <B>sell at 15:15 the same day</B>.
          </li>
          <li>
            <B>Long &amp; short</B> also sells the mirror image: an open above the previous high by more than 1σ, below
            the 20-day average.
          </li>
          <li>
            <B>Stop</B>: none is the book's rule (exit only at 15:15). 1σ puts a stop one standard deviation from entry.
            Either way <B>1R = 1σ</B> from entry.
          </li>
          <li>Everything the signal uses is known at 09:15: the previous close, low and high, and today's open.</li>
        </List>
      </Section>

      <Section title="Fixed to limit curve fitting">
        <List>
          <li>
            The gap size (1σ), the 90-day and 20-day windows and the same-day exit are the book's values and are not
            tuned. Earlier tests of a 1.5σ gap and of holding to the next, 3rd or 5th day were dropped: holding longer
            kept the same edge per trade with 2–5× the drawdown.
          </li>
          <li>The default (top 10, long only, no stop) is the book's version; quote that one, not the best row.</li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>
            <B>All F&amp;O stocks</B>: every stock with a current NFO future, 15m candles from February 2015 (or listing,
            if later). <B>Nifty 50 stocks</B> and <B>F&amp;O indices</B> use the same rules on their own lists.
          </li>
          <li>
            Days where the first 15m open is more than 1% away from the daily open are skipped: a stale 09:15 print on a
            corporate-action day (e.g. TMPV's 2025 demerger). Short special sessions are skipped too.
          </li>
          <li>
            Net results are after <B>NSE futures charges and slippage</B>; rupees are for one lot at today's lot sizes.
          </li>
        </List>
      </Section>

      <Section title="Biases to keep in mind">
        <List>
          <li>
            <B>Survivorship</B>: the lists are today's Nifty 50 and today's F&amp;O stocks for the whole period. Stocks
            that gapped down and kept falling until they left F&amp;O or were delisted are missing, which flatters the
            long side most.
          </li>
          <li>
            <B>Entry fill</B>: the 09:15 open is the pre-open auction price; live you need to join the pre-open session
            or accept some slippage.
          </li>
          <li>
            <B>The real test</B> is paper trading the book version going forward: live results can't be fitted.
          </li>
        </List>
      </Section>
    </>
  );
}

export function GapMomentumInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Ernest Chan's <B>opening gap strategy</B> (Algorithmic Trading, ch. 7, Example 7.1, on Euro STOXX 50
          futures), the mirror image of buy-on-gap, pure intraday:
        </p>
        <List>
          <li>
            <B>Buy at the 09:15 open</B> when the index opens above the previous day's high by more than <B>0.1σ</B>{" "}
            (σ = standard deviation of its last 90 daily returns).
          </li>
          <li>
            <B>Short at the open</B> when it opens below the previous day's low by more than 0.1σ.
          </li>
          <li>
            <B>Exit at 15:15</B> the same day. No average filter, no ranking: each index trades on its own.
          </li>
          <li>
            The book's version trades both sides with no stop; 1σ puts a stop one standard deviation away. 1R = 1σ.
          </li>
        </List>
      </Section>
      <Section title="Why test it">
        <p>
          Chan's argument: gaps <B>continue</B> in index futures (stop orders and momentum traders pile in) but{" "}
          <B>reverse</B> in single stocks (buy-on-gap). This page tests the index half, and the same rule on the F&amp;O
          stocks as a check on the stock half.
        </p>
      </Section>
      <Section title="Data">
        <List>
          <li>
            <B>F&amp;O indices</B> (NIFTY, BANK, FIN SERVICE, MID SELECT, NEXT 50), spot data standing in for futures,
            15m candles from 2015 (MID SELECT from 2022).
          </li>
          <li>
            <B>F&amp;O stocks</B>: today's 218 stocks with futures, 15m candles from 2015. No ranking, as on the indices:
            every stock that gaps by 0.1σ is traded (about 20 a day).
          </li>
          <li>
            Not extended to the daily history: before 2011 Kite's index opens are often just the previous close, so the
            opening gap can't be measured.
          </li>
          <li>
            The signal uses the spot index open; live you would trade the future, whose open differs a little (basis).
          </li>
        </List>
      </Section>
      <Section title="Result">
        <p>
          It does not work on Indian indices: the book version loses before costs (about −0.06R per trade gross,
          −0.16R net over 3,400+ trades, no profitable year). Index gaps here tend to fade rather than run. Fading them
          instead would be a new idea fitted to this result, so it is not offered here.
        </p>
        <p className="mt-2">
          On the F&amp;O stocks it loses more clearly: about −0.13R per trade gross, −0.19R net over 58,000 trades, every
          year negative. That is the stock half of Chan's argument showing up: stock gaps reverse, which is what
          buy-on-gap trades.
        </p>
      </Section>
    </>
  );
}

export function XsmrInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Ernest Chan's <B>linear long-short model</B> (Algorithmic Trading, ch. 4, after Khandani &amp; Lo):
        </p>
        <List>
          <li>
            Every day each stock gets a weight <B>−(its return − the average return) ÷ Σ|differences|</B>: long the
            stocks that lagged the cross-section, short the ones that led, in proportion to the move.
          </li>
          <li>The long and short sides are each half of gross exposure, so the book is market-neutral.</li>
          <li>
            <B>Intraday</B>: the return is previous close → 09:15 open; positions are opened at the open and closed at
            15:15. <B>Daily</B>: the return is the last day's 15:15 → 15:15; positions are held to 15:15 the next day and
            rebalanced daily.
          </li>
          <li>No parameters to tune: both versions are the book's.</li>
        </List>
      </Section>

      <Section title="The fill check">
        <List>
          <li>
            The book enters at the <B>09:15 open</B>, which is NSE's opening-auction price. Entry 09:30 and 09:45 keep
            the same signal but enter 15 / 30 minutes later.
          </li>
          <li>
            Almost all of the edge sits in that first 15 minutes: entering at 09:30 turns a strong result into a loss.
            So the strategy is only real if you can trade at the auction price, i.e. in the{" "}
            <B>pre-open session (09:00–09:08)</B>, deciding from the indicative prices. Buy-on-gap has the same property.
          </li>
          <li>The edge has also been shrinking: lower every year since 2021, negative in 2026.</li>
        </List>
      </Section>

      <Section title="Stop (not in the book)">
        <List>
          <li>
            <B>1σ</B> uses Buy on gap's stop: one standard deviation of the stock's last 90 daily returns from entry,
            below for longs and above for shorts. It's hit when a 15m candle up to 15:15 trades through it, and the
            exit is at the stop price.
          </li>
          <li>The positions and weights stay the same as the book's; only the exit changes. It's only available for the 09:15 entry.</li>
        </List>
      </Section>

      <Section title="Returns and costs">
        <List>
          <li>
            Results are <B>% of gross exposure</B> (long + short), summed day by day at a fixed size, not compounded and
            not R per trade. Annual = mean daily × 248.
          </li>
          <li>
            Costs are charged on every rupee traded: NSE futures charges (STT on sells, exchange and SEBI fees with GST,
            stamp duty, ₹20 a order on a ₹7L lot) plus the chosen slippage. The intraday version trades the whole book
            twice a day.
          </li>
          <li>
            Holding ~190 stocks at once is not possible with futures lots. <B>Take</B> cuts the book down: 5 long + 5
            short or 3 long + 3 short, the stocks furthest from the average move, equal rupees each. That is a practical
            restriction, not the book's rule; it concentrates the bet, so returns and drawdowns both grow.
          </li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>
            Today's F&amp;O stocks (or Nifty 50) from February 2015, 15m candles. The 15:15 price is the close of the
            15:00 candle.
          </li>
          <li>
            Cleaned, not tuned: opens more than 1% from the daily open, 15:15 prices outside the day's range (bad prints)
            and moves over 20% (corporate actions) are left out that day.
          </li>
          <li>
            <B>Survivorship</B>: today's lists for the whole period. Stocks that collapsed out of F&amp;O are missing.
          </li>
        </List>
      </Section>
    </>
  );
}

export function PairsInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Pairs trading with cointegration (Ernest Chan, Algorithmic Trading, ch. 2–4), walk-forward so every trade is
          out of sample:
        </p>
        <List>
          <li>
            <B>Pick (once a year)</B>: every pair of F&amp;O stocks in the same NSE industry (Nifty 500 classification)
            gets the Engle–Granger test on the previous calendar year's daily closes: regress one price on the other, then
            an ADF test on the leftover spread. Both orders are tried; the stronger one is kept. Pairs that pass at 5%
            with a positive hedge ratio are traded the next year.
          </li>
          <li>
            <B>Bollinger</B>: spread = y − hedge × x (hedge fixed from the pick year). z-score over a lookback equal to the
            spread's half-life. Long the spread below z = −1, short above +1, exit when z crosses 0. Hold 1 share of y
            against hedge shares of x.
          </li>
          <li>
            <B>Kalman filter</B>: re-estimates the hedge ratio every day (the book's δ = 0.0001, Ve = 0.001). Long the
            spread while the forecast error is below −√Q, short while above +√Q. Run on log prices so the book's settings
            mean the same for cheap and expensive stocks; the hedge is in rupees and rebalanced daily.
          </li>
          <li>Open positions are closed on the last trading day of the year; the pick starts over.</li>
        </List>
      </Section>

      <Section title="Fill and take">
        <List>
          <li>
            The book trades at the close the signal comes from. <B>Next close</B> keeps the signal and trades one day
            later: a check that the result does not depend on that fill.
          </li>
          <li>
            <B>Take</B>: all pairs is the book (often 100+ pairs, 200+ legs). Top 10 / top 5 trade only the pairs with the
            strongest test result, chosen before the year starts, so there is no look-ahead.
          </li>
        </List>
      </Section>

      <Section title="Returns and costs">
        <List>
          <li>
            Capital is split equally across the year's pairs (all, 10 or 5) and sits idle while a pair is flat. Results are
            % of total capital, summed day by day, not compounded. Annual = mean daily × 248.
          </li>
          <li>
            Costs on every rupee traded: NSE futures charges plus the chosen slippage. Short legs need futures (or SLB) to
            hold overnight.
          </li>
          <li>
            Click a month for the trades closed in it. "Pair" results are on that pair's own capital; "book" is its share
            of the whole account.
          </li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>Daily closes of today's F&amp;O stocks from 2000; the first pick year is 2000, the first trading year 2001.</li>
          <li>
            A pair is stopped for the rest of the year if either stock moves more than 20% in a day or has no price
            (corporate action or bad data); that day's P&amp;L is not counted.
          </li>
          <li>
            <B>Survivorship</B>: today's F&amp;O list for every year, and today's industry for each stock.
          </li>
        </List>
      </Section>
    </>
  );
}

export function XsmomInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">Cross-sectional momentum on stocks (Ernest Chan, Algorithmic Trading, ch. 6), with the book's parameters:</p>
        <List>
          <li>
            <B>Rank</B>: every day after the close, rank the stocks by their return over the last 252 trading days (12
            months).
          </li>
          <li>
            <B>Pick</B>: buy the top 10% and short the bottom 10% (the book: the top and bottom 50 of the S&amp;P 500), equal
            rupees each. Long and short are each half of the day's money.
          </li>
          <li>
            <B>Hold 25 trading days</B>, overlapping: each day's picks get 1/25 of the capital, so the book on any day is the
            last 25 days' picks together. About 1/25 of it changes each day instead of all of it once a month, so a
            stock is often held by several of the 25 books at once.
          </li>
        </List>
      </Section>

      <Section title="Fill and take">
        <List>
          <li>
            The book trades at the close the ranking comes from. <B>Next close</B> keeps the ranking and trades one day
            later: a fill check.
          </li>
          <li>
            <B>Take</B>: 10% per side is the book (about 22 a side on the F&amp;O list, 5 on the Nifty 50, so 5 + 5 is the
            same as the book there). Across 25 overlapping books that is ~45 stocks held at once on the F&amp;O list.{" "}
            <B>5 + 5</B> picks only the 5 strongest and weakest each day: ~17 stocks held at once; <B>1 + 1</B> only the single strongest and weakest.
          </li>
        </List>
      </Section>

      <Section title="Returns and costs">
        <List>
          <li>
            Results are % of gross exposure (long + short), summed day by day, not compounded. Annual = mean daily × 248.
          </li>
          <li>
            Costs on every rupee traded: NSE futures charges plus the chosen slippage. Turnover is about 6× capital a year.
            The monthly futures roll is not charged; short legs need futures to hold overnight.
          </li>
          <li>Click a month for its days, and a day for every stock held into that close.</li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>Daily closes from 2000; the first full book is in January 2004 (a 12-month ranking needs enough stocks with history).</li>
          <li>
            A stock is ranked only with 253 straight closes and no daily move over 20% in the window (a split or bonus in
            unadjusted prices, or a bad print). A day's move over 20% earns nothing. Sparse special sessions are dropped.
          </li>
          <li>
            <B>Survivorship</B>: today's F&amp;O list for every year. Momentum is sensitive to this: stocks that rose
            enough to join the list are in it from the start, and losers that dropped out are missing.
          </li>
          <li>
            <B>Momentum crashes</B>: the book lost heavily in 2008–09, when the market fell and then rebounded, and last
            year's losers led the rebound.
          </li>
        </List>
      </Section>
    </>
  );
}

export function QmomInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Quantitative Momentum (Wesley Gray &amp; Jack Vogel, Wiley 2016), long only, with the book's parameters:
        </p>
        <List>
          <li>
            <B>Universe</B>: the F&amp;O stocks, which are already the large and liquid names. The book uses US stocks
            above the 40th size percentile.
          </li>
          <li>
            <B>Momentum</B>: the return from 12 months ago to 1 month ago. The last month is skipped because short-term
            moves tend to reverse. Keep the top 10%.
          </li>
          <li>
            <B>Frog in the pan (FIP)</B>: over the same window, the share of down days minus the share of up days. A lower
            FIP means a smoother climb, and the book argues that smooth climbs keep going because investors under-react to
            them. Keep the smoother half of the top 10%: about 10 stocks on the F&amp;O list.
          </li>
          <li>
            <B>Seasonality</B>: rebalance quarterly, at the last close of February, May, August and November (ahead of
            quarter-end window dressing). Equal weight, held until the next rebalance; weights drift with prices in between.
          </li>
        </List>
      </Section>

      <Section title="Versions">
        <List>
          <li>
            <B>Momentum only</B> drops the FIP filter and holds the whole top 10%. It shows what FIP adds.
          </li>
          <li>
            <B>Monthly</B> uses the book's selection but rebalances every month end. It shows what the quarterly timing does.
          </li>
          <li>
            <B>All stocks</B> holds every rankable stock at equal weight, rebalanced quarterly. It's the benchmark: the
            strategy is only worth running for what it earns above this.
          </li>
        </List>
      </Section>

      <Section title="Hedge (not in the book)">
        <List>
          <li>
            <B>Short Nifty</B> adds a Nifty futures short equal to the long book's value (1 : 1 in rupees, no beta
            estimate), so the result is only what the picks earn over the Nifty. Returns stay on the long capital; the
            short needs its own margin.
          </li>
          <li>
            In one-lot mode it shorts the whole number of Nifty lots nearest the book's value at each rebalance, at least one.
          </li>
          <li>
            The hedge does not stop momentum crashes. In 2008 the picks fell harder than the Nifty, and a hedge sized
            from their past beta didn't fix that either (tested: still about −44% that year).
          </li>
        </List>
      </Section>

      <Section title="Returns and costs">
        <List>
          <li>Results are % of capital, fully invested long, summed day by day, not compounded. Annual = mean daily × 248.</li>
          <li>
            Being long only, it carries the full market risk: 2008 and 2020 show the drawdowns. A drawdown over 100% is
            possible here only because returns are summed at a fixed size, not compounded.
          </li>
          <li>
            Costs on every rupee traded: NSE futures charges plus the chosen slippage. The monthly futures roll is not
            charged. Holding futures also costs the carry built into their price, roughly the interest rate, which daily
            spot closes don't include.
          </li>
          <li>Click a month for its days, and a day for every stock held and its momentum and FIP at the last rebalance.</li>
        </List>
      </Section>

      <Section title="Data">
        <List>
          <li>Daily closes from 2000; the first rebalance is February 2004.</li>
          <li>
            Data hygiene as in Cross-sectional momentum: a stock is ranked only with 253 straight closes and no daily move
            over 20% in the window, and a day's move over 20% earns nothing.
          </li>
          <li>
            <B>Survivorship</B>: today's F&amp;O list is used for every year. That flatters both the strategy and the
            benchmark, and momentum most, since stocks that rose enough to join the list are in it from the start.
          </li>
        </List>
      </Section>
    </>
  );
}

export function ConnorsInfo() {
  return (
    <>
      <Section title="The rules">
        <p className="mb-2">
          Short-term mean reversion (Larry Connors &amp; Conor Sen, How Markets Really Work, 2nd ed. 2012), long only:
        </p>
        <List>
          <li>
            <B>Trend filter</B>: the stock is above its 200-day average. The book's finding is that short-term weakness
            gets bought in uptrends.
          </li>
          <li>
            <B>Setup</B> (the book's): the <B>2-day RSI below 10</B>; or a new 10-day closing low; or 3 down closes in a row.
          </li>
          <li>
            <B>Timing</B>: everything at 15:15. The signal uses official closes to yesterday plus today's 15:15 price,
            and the entry is that 15:15 price. The official close (a 30-minute average) can't be traded, and waiting for
            the next open gives up the overnight move, where much of the edge sits.
          </li>
          <li>
            <B>Exit</B>: the 15:15 price 5 trading days later (the book's week); 2 days as a check.
          </li>
          <li>
            <B>Prices · Close</B> runs the same rules on official closes from daily candles, so it goes back to 2004.
            The close is a 30-minute average and can't be traded exactly, but on 2015–2026 the two versions are within a
            few points a year of each other.
          </li>
        </List>
      </Section>

      <Section title="Book and take">
        <List>
          <li>
            Each day's picks get 1/5 of capital, split equally, so the book is the last five days' picks together. A day
            with no picks leaves its slice in cash.
          </li>
          <li>
            <B>All signals</B> is the book: about 10 a day on the F&amp;O list, ~30 stocks held. <B>Lowest 5 / 3 RSI</B>{" "}
            takes only the day's most oversold: about 12 / 8 held.
          </li>
          <li>
            <B>No threshold</B> is the control. With All it holds every stock above its 200-day average (the baseline);
            with a take it buys the day's lowest RSIs whatever their level. Compare with it to see what the setup itself adds.
          </li>
        </List>
      </Section>

      <Section title="Max open and stop (not in the book)">
        <List>
          <li>
            <B>Max open</B> is a margin budget. <B>Many</B> (the book): each day's picks share a fifth of capital, and a stock picked again
            while held is bought again. <B>1–10</B> (the slider next to Capital): at most that many positions open at once, for a margin
            budget (each open futures lot needs its own margin). Each position gets capital ÷ N, equal rupees (in futures, rounded to whole lots in practice). A new trade
            starts only when a slot frees up: the most oversold qualifying stock not already held, from that 15:15 on.
            The take doesn't apply. Fewer slots means bigger swings.
          </li>
          <li>
            <B>Stop 1σ / 2σ</B>: 1 or 2 standard deviations of the stock's last 90 daily returns below the buy price (1σ
            is Buy on gap's stop). It's checked on each day's low (out at the open if the stock gaps through it) and on
            the 15m lows up to 15:15 on the sell day, and the exit is at the stop price.
          </li>
          <li>
            Connors argues stops hurt mean reversion, and the test agrees: a 1σ stop catches over half the trades (they
            are bought falling and often dip further first) and cuts the return by about two thirds.
          </li>
        </List>
      </Section>

      <Section title="What the tests show">
        <List>
          <li>
            Per trade, oversold stocks beat the average stock in an uptrend by about 0.2% over 5 days. But much of that
            comes from market-wide sell-offs, when dozens of stocks signal at once, and a daily book doesn't weight those
            days more. So the uncapped book earns about the same as the baseline.
          </li>
          <li>
            What helps is <B>picking the day's most oversold</B> (Lowest 3 RSI), with or without the below-10 threshold.
          </li>
          <li>
            The book's short side (overbought stocks below the 200-day average) lost in every test, so it isn't included.
          </li>
        </List>
      </Section>

      <Section title="Returns, costs and data">
        <List>
          <li>Results are % of capital, invested long, summed day by day, not compounded. Annual = mean daily × 248.</li>
          <li>
            Costs on every rupee traded: NSE futures charges plus the chosen slippage. Turnover is about 90× capital a
            year (a 5-day hold), so slippage matters. The futures roll is not charged.
          </li>
          <li>
            15-minute candles start in February 2015 (daily closes in 2003 for the Close version). Every book is computed on request; the first view after a restart takes ~15 s to load the prices. A stock qualifies with 90% of the last 200 closes (Kite's daily history has a hole from 24 May to 22 June 2004, when most stocks are missing; days like that aren't counted) and no move over
            20% in the window; a day's move over 20% earns nothing.
          </li>
          <li>
            <B>Survivorship</B>: today's F&amp;O list is used for every year, which flatters every long position. Judge the
            setups against the no-threshold control, not against zero.
          </li>
        </List>
      </Section>
    </>
  );
}
