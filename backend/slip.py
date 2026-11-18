"""Each model's slippage, a fraction per side, from how it would really trade (the pages' defaults: V2BuyOnGap's
SLIPPAGE_DEFAULT): the opening auction costs nothing; an exit at 15:15 or a liquid future a little; a buy-stop
(Oops) fills above its level in a fast move. The server's own figures (the dashboard's paper books, the paper
vs backtest check) use these."""

SLIPPAGE = {
    "gap": 0.0001, "gapmom": 0.0001, "xsmr": 0.0001, "oops": 0.0005, "connors": 0.0001, "tom": 0.0001,
    "kbdt": 0.0002, "pairs": 0.0002, "xsmom": 0.0002, "qmom": 0.0002, "ltlv": 0.0002, "mix": 0.0002,
}
