// Original, finite starter series. These articles contain no live prices,
// forecasts, invented experts, rankings or account-specific recommendations.
const posts = [
  {
    slug: "forex-pips-points-and-pip-value",
    title: "Pips, points and pip value: read the units first",
    category: "Forex basics", tags: ["forex", "pips", "calculators"],
    shortDescription: "Understand the units behind a forex price change, then check a worked pip-value example against the symbol specification.",
    content: `<p>A price change is easier to interpret when its unit is clear. A pip, a platform point and a cash profit or loss describe different things. Writing those units beside a calculation helps prevent a small-looking number from being mistaken for a small financial exposure.</p>
<h2>Separate the price step from the cash value</h2>
<p>A pip is a quoting convention. For many non-JPY forex pairs it is 0.0001; for many JPY pairs it is 0.01. Those conventions are not a substitute for checking the actual instrument. A point is the platform's quoted price increment. An extra decimal place can mean that several points make one pip. MetaTrader's symbol specification shows the digits and contract settings supplied by the broker.</p>
<p>For a simple forex illustration, assume a contract of 100,000 base-currency units per lot, a volume of 0.10 lot and a pip size of 0.0001. The exposure is 10,000 base-currency units. Multiplying that exposure by the pip size gives 1 unit of the quote currency per pip. If the account uses a different currency, a conversion is still needed.</p>
<h2>Keep the assumptions beside the example</h2>
<p>Suppose the example pair is EUR/USD and the account currency is USD. Under those assumptions, a 15-pip change corresponds to USD 15 before trading costs. The direction of the position determines whether the change is favourable. A different lot size, contract or account currency changes the result. This arithmetic does not establish the conditions of any particular trading account.</p>
<p>The same shortcut should not be copied into a gold, index or cryptocurrency calculation. Those symbols can have different contract sizes and tick-value rules. Use their specifications and the account's own trade preview rather than assuming that a familiar forex convention applies.</p>
<h2>A quick unit check</h2>
<ul><li>Write the symbol and account currency.</li><li>Confirm the contract size and the volume unit.</li><li>Distinguish one platform point from one pip.</li><li>Label the currency of the calculated value.</li><li>Keep spread, commission, financing and conversion effects separate from the price-change example.</li></ul>
<p>The <a href="/currency-calculator">BDFX forex calculator</a> can help you work through its stated assumptions. Compare its inputs with the current platform specification before relying on a result. If two figures disagree, inspect the units and conversion first.</p>
<p>This is an educational calculation, not a prediction or a recommendation to trade.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/trading/market_watch">MetaQuotes: Market Watch and symbol specifications</a></p>`,
  },
  {
    slug: "margin-and-leverage-explained",
    title: "Margin and leverage: read the trading requirement",
    category: "Risk and account basics", tags: ["margin", "leverage", "risk"],
    shortDescription: "Distinguish required margin from position exposure and maximum loss, using a simple leverage example with explicit assumptions.",
    content: `<p>Margin answers a funding question: how much money is required to support a position under the account's current rules? It does not answer how much that position can lose. Treating margin as a loss limit is a common way to misunderstand leveraged exposure.</p>
<h2>Start with exposure</h2>
<p>Consider an illustrative position with a notional exposure of USD 1,000. If a simple 1:50 leverage rule applied, the initial margin calculation would be USD 1,000 divided by 50, or USD 20. This simplified example leaves out currency conversion, instrument-specific requirements, tiered rules and changes in margin rates. The platform's actual requirement takes priority over a general example.</p>
<p>A one-percent change in the value of that USD 1,000 exposure is USD 10 before costs. Changing the leverage setting does not turn the same one-percent price movement into a smaller movement for that unchanged position. Leverage changes the funding relationship; the exposure and price movement still matter.</p>
<h2>Read the account figures together</h2>
<p>Balance, equity, used margin and free margin each describe a different part of the account. A written comparison should name the figure being discussed. A balance snapshot alone can leave out the effect of open positions. A margin figure alone can leave out how close the account is to its current margin thresholds.</p>
<p>Before a practice calculation, record the instrument, contract size, position volume, account currency and the margin requirement displayed by the platform. Then write down what the calculation excludes. This makes it possible to revisit the example later without confusing a teaching assumption with an actual account condition.</p>
<h2>Questions to resolve before using a number</h2>
<ul><li>Is the displayed amount notional exposure, required margin or a cash result?</li><li>Does this symbol use the simple forex margin model or another calculation?</li><li>Are the position and account currencies different?</li><li>Are the relevant margin-call and stop-out conditions documented for the account?</li><li>Have trading costs and a possible change in execution price been considered separately?</li></ul>
<p>Use the <a href="/currency-calculator">forex calculator</a> to explore a stated numerical example and the <a href="/help-centre">Help Centre</a> for account and platform questions. A calculator estimate is not an execution quote or a guarantee that an order will be accepted.</p>
<p>Leveraged products can produce substantial losses. This explanation is educational and does not determine a suitable position size or leverage setting for any person.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/trading/performing_deals">MetaQuotes: executing trades and trade-dialog information</a></p>`,
  },
  {
    slug: "mt5-market-limit-and-stop-orders",
    title: "Market, limit and stop orders in MetaTrader 5",
    category: "MetaTrader 5", tags: ["MT5", "orders", "execution"],
    shortDescription: "Read an MT5 order ticket by separating the requested action, its activation conditions and the eventual execution result.",
    content: `<p>An order ticket records an instruction. A deal records an execution, and a position describes an exposure that remains open. Keeping those words separate makes the trade history easier to read, especially when an instruction is rejected, expires or is only partially filled.</p>
<h2>What the order is asking for</h2>
<p>A market order asks for a transaction under the symbol's available execution rules. A pending order sets conditions for an instruction to activate later. The order types available in MetaTrader 5 depend on the instrument and server configuration; the platform documentation describes the general types, not a promise that every account supports all of them.</p>
<p>A buy limit is normally placed below the current market and a sell limit above it. A buy stop is normally placed above the market and a sell stop below it. These names describe different instructions, not different levels of certainty. Stop-limit instructions add another step: a stop condition activates a limit order, which may then remain unfilled.</p>
<h2>Activation is different from execution</h2>
<p>Writing a level into an order does not guarantee that every transaction will execute at exactly that level. Spread, gaps, available liquidity, execution mode and the symbol's rules can affect the result. Stop Loss and Take Profit are associated exit instructions; they should not be described as guaranteed maximum-loss or guaranteed-profit amounts.</p>
<p>For a practice walkthrough, choose a demo instrument and write down the intended action in plain words before selecting an order type. Record the symbol, side, volume, requested level, expiry and any attached exit levels. Compare that note with the ticket. The goal of the exercise is to catch a mismatch in the instruction, not to predict the next price move.</p>
<h2>Read the result in the history</h2>
<p>After a demo instruction has been processed, compare the order record with any resulting deals and position. Keep the requested price separate from the execution price. If the order was not filled, record its displayed state rather than treating every absence of a position as a connection fault.</p>
<ul><li>Was the selected symbol the intended instrument?</li><li>Was volume entered in lots rather than a cash amount?</li><li>Were minimum distance and expiry rules satisfied?</li><li>Does the record show an execution, a cancellation or a rejection?</li></ul>
<p>Use the <a href="/platform">platform guide</a> for access information and the <a href="/help-centre">Help Centre</a> when an account-specific setting needs clarification. Never share a trading password or OTP in a support message.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/trading/orders">MetaQuotes: order types, execution and fill policies</a></p>`,
  },
  {
    slug: "read-mt5-symbol-specifications",
    title: "Read MT5 symbol specifications before a trade",
    category: "MetaTrader 5", tags: ["MT5", "contracts", "lot sizes"],
    shortDescription: "Use a repeatable checklist to identify contract size, volume rules, trading sessions and other instrument-specific settings.",
    content: `<p>Two symbols can look similar on a chart while representing different trading contracts. Their price format, volume limits, trading sessions or margin calculation can differ. The symbol name is a starting point; its specification is the place to check the instrument's actual settings.</p>
<h2>Open the specification for the exact symbol</h2>
<p>In the desktop MetaTrader 5 Market Watch window, the symbol's context menu provides a Specification view. Check the exact symbol and account rather than relying on a screenshot from another server. MetaQuotes documents the kinds of settings that a broker can supply; the values displayed in your account are the relevant values to inspect.</p>
<p>Begin with the contract size and the volume unit. Next, check the minimum volume, maximum volume and volume step. An illustrative 0.10-lot input only makes sense when the contract and permitted increment are known. Do not assume that the same volume means the same exposure for a currency pair and an index.</p>
<h2>Build a short instrument note</h2>
<p>A useful note can fit on one page. Put the symbol and date at the top, followed by the account currency. Add the contract size, quoting precision and the fields needed for the calculation being performed. Keep values copied from the platform separate from values assumed for an exercise.</p>
<p>Record the trading-session information and the time basis shown by the platform. A market being familiar does not mean that every offered contract trades without breaks. If a symbol is unavailable at a particular time, its schedule and the account's permissions are useful places to check before changing connection settings.</p>
<h2>Keep costs and restrictions visible</h2>
<p>Use the current account terms to check which charges or financing conditions apply. Generic descriptions of spreads, swaps or commissions do not establish the pricing of a specific BDFX account. If a value appears unclear or differs from another page, ask support to clarify the exact symbol and setting.</p>
<ul><li>Record the instrument identifier without including passwords or personal account details.</li><li>State the field being queried and the time it was observed.</li><li>Explain the calculation or platform action that raised the question.</li><li>Avoid posting an unredacted account screenshot publicly.</li></ul>
<p>The <a href="/currency-calculator">calculator</a> is useful for stated forex examples, while the <a href="/help-centre">Help Centre</a> explains how to escalate a platform question. An instrument note helps make that conversation precise; it does not establish that a trade is appropriate.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/trading/market_watch">MetaQuotes: viewing symbol specifications</a></p>`,
  },
  {
    slug: "economic-calendar-time-zones-and-releases",
    title: "Economic calendar times: check the time zone first",
    category: "Market education", tags: ["economic calendar", "time zones", "market data"],
    shortDescription: "Read calendar times, event labels and releases carefully, without treating a forecast or an impact badge as a trading signal.",
    content: `<p>An economic calendar is a schedule of releases and events. It helps identify what information is expected and when it may become available. A calendar label cannot tell you in advance which direction a market will move or what an execution price will be.</p>
<h2>Confirm the time basis</h2>
<p>Start by checking the calendar's displayed time zone. Keep that separate from the time on your device and the time used by a trading server. When daylight-saving rules change in the country publishing a release, the relationship between local release time and another region's clock can change.</p>
<p>For a planning exercise, write the event's displayed date, time and time zone in a note. If a second source uses another zone, convert the complete date and time rather than just adding a number of hours to the clock. Crossing midnight can change the date as well as the hour. An entry with an uncertain or all-day time should not be converted into an invented precise minute.</p>
<h2>Read the label before the number</h2>
<p>Similar event names can refer to different periods, units or versions of a release. Check whether a figure is a level, a percentage change, an annualised measure or a revision. A previous value and a forecast are different kinds of information; neither should be silently treated as the newly released actual value.</p>
<p>When reviewing an event, record the period covered and the publication source. If an official release is available, compare its definitions with the calendar label. Keep any later revision separate from the number first observed. This produces a useful learning record without relying on a screenshot whose context has been lost.</p>
<h2>Keep expectations separate from outcomes</h2>
<p>An impact badge is a calendar provider's classification, not a guaranteed amount of volatility. A difference between a forecast and an actual figure is not, by itself, an instruction to buy or sell. Market expectations, simultaneous information and changing liquidity can make a simple interpretation unreliable.</p>
<ul><li>Check the time zone and complete date.</li><li>Identify the reporting period and unit.</li><li>Distinguish forecasts, previous values and revisions.</li><li>Record the official source when checking a release.</li><li>Keep observations separate from any trading decision.</li></ul>
<p>Open the <a href="/economic-calendar">BDFX economic calendar</a> to review its displayed schedule and the <a href="/education">Education page</a> for related learning tools. Verify an event with the issuing institution when its timing or definition matters. No release time or market forecast is supplied by this article.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/startworking/interface">MetaQuotes: platform windows, news and account tools</a></p>`,
  },
  {
    slug: "mt5-demo-practice-journal",
    title: "Build an MT5 practice journal you can review",
    category: "Trading education", tags: ["demo", "MT5", "learning"],
    shortDescription: "Turn a demo session into a clear learning record by separating the intended instruction, platform result and later review.",
    content: `<p>A practice session becomes more useful when it has a question and a record. Simply watching a demo balance rise or fall can hide mistakes in units, order selection or account navigation. A journal helps distinguish learning how the platform works from making a claim about future performance.</p>
<h2>Choose one operational question</h2>
<p>Keep the exercise narrow. For example, the question might be whether you can locate a symbol specification, distinguish an order from a deal, or find a completed demo transaction in the history. Write that question before starting. A focused exercise is easier to review than a session whose purpose changes with every price movement.</p>
<p>Record the platform version if it matters, the type of practice account and the instrument being examined. Do not put a password, OTP or other secret in the journal. If you use screenshots, crop or redact personal identifiers before storing them in a shared location.</p>
<h2>Separate intention and observation</h2>
<p>Use three columns: intended action, observed result and question for review. In the first column, describe the instruction in ordinary words. In the second, record what the platform actually displayed, including any rejection or cancellation. In the third, note the difference without rewriting the original intention after the outcome is known.</p>
<p>An illustrative entry might say that a volume input was rejected, then record the permitted step shown by the specification. The lesson is an input rule. It should not be converted into a conclusion that a different volume is financially suitable for a live account.</p>
<h2>Review process before performance</h2>
<p>Ask whether the units were labelled, the intended account was selected and the order type matched the written exercise. Use the platform's history to check the result rather than memory alone. Identify one unresolved question to practise or clarify next time.</p>
<p>Demo outcomes do not establish a live execution result or predict future returns. Live trading also involves real financial consequences and conditions that a practice exercise may not reproduce. A journal is a learning aid, not proof that a strategy is safe or profitable.</p>
<ul><li>Write one question for the session.</li><li>Keep the original instruction unchanged.</li><li>Record errors as observations rather than hiding them.</li><li>Review the relevant history or specification.</li><li>Protect account identifiers and credentials.</li></ul>
<p>Use the <a href="/platform">platform guide</a> for setup information and the <a href="/help-centre">Help Centre</a> for navigation questions. The aim is a clearer record of what happened and what remains to be learned.</p>
<h2>Further reading</h2><p><a href="https://www.metatrader5.com/en/terminal/help/startworking/interface">MetaQuotes: platform interface and Toolbox</a></p>`,
  },
];
module.exports = posts.map(post => ({ ...post, author: "Billion Dollar FX", coverImage: "https://www.billiondollarfx.com/social-card.png", coverAlt: `Billion Dollar FX learning guide: ${post.title}`, faqs: [], allowComments: false }));
