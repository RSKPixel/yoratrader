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
          The same code as the live model pages (see their info buttons), run day by day over the last{" "}
          <B>5 years of 15m candles</B>:
        </p>
        <List>
          <li>
            <B>Opening Range Breakout</B> in 18 settings: opening range of <B>30, 45 or 60 minutes</B>; stop at the
            tighter of the opposite range side and <B>0.5× or 1.0× ATR</B>; and a <B>minimum stop</B> of any, 0.6% or
            1.0% of price (tighter setups are skipped). 30 min · 0.5× ATR · any stop is the live model.
          </li>
          <li>
            <B>Fib Pullback</B> and <B>Key Break + Fib</B> with their live settings.
          </li>
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
            The table at the bottom compares every model and setting under the current dataset, cap and slippage.
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
            SELECT, NIFTY NEXT 50), spot data standing in for their futures. An index has no volume, so ORB's{" "}
            <B>volume and VWAP filters are off</B>; everything else is the same. The other models don't use volume.
          </li>
          <li>
            <B>Nifty 50 stocks</B>: today's 50 constituents from niftyindices.com, cash market with volume, full model.
          </li>
          <li>
            Daily candles start about 4 months before the first 15m day, so the SMA50 trend and ATR(14) are ready from
            the start.
          </li>
          <li>
            <B>Update data</B> downloads only candles newer than the last stored ones, then reruns every model and
            setting (a few minutes).
          </li>
        </List>
      </Section>

      <Section title="Costs">
        <List>
          <li>
            <B>R</B> is before costs. <B>Net R</B> subtracts NSE futures charges and slippage, converted to R using each
            trade's own risk: STT 0.05% on the sell side, exchange 0.00173% and SEBI on both sides, stamp 0.002% on the
            buy side, ₹20 per order brokerage (3 orders if T1 is hit) and 18% GST.
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
            stock's current lot). Lot sizes changed over the 5 years, so older trades are shown as if traded at today's
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
            <B>Cash vs futures</B>: futures trade at a premium to cash and have their own volume, so live fills and the
            volume filter will differ a little.
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
