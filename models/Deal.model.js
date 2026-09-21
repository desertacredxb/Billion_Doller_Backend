const mongoose = require("mongoose");

const DealSchema = new mongoose.Schema(
  {
    login: { type: String, required: true, index: true }, // #POSITION_LOGIN#
    order: { type: String, required: true, unique: true }, // #DEAL_TICKET# - dedup key, one row per deal
    action: { type: String }, // #DEAL_TYPE# - EnDealAction (0=buy,1=sell,2=balance,...)
    entry: { type: String }, // #DEAL_ENTRY# - EnEntryFlags (0=in,1=out,...)
    time: { type: String }, // #DEAL_TIME# - unix seconds, as sent by MT5
    expertPositionId: { type: String }, // #DEAL_EXPERT#
    symbol: { type: String }, // #POSITION_SYMBOL# - raw broker symbol, e.g. "XAUUSD.lp"
    price: { type: String }, // #DEAL_PRICE#
    volume: { type: String }, // #DEAL_VOLUME# - raw MT5 units (lots = volume / 10000)
    profit: { type: String }, // #DEAL_PROFIT#
    pricePosition: { type: String }, // #DEAL_PRICE# (duplicated per the webhook template)
    group: { type: String }, // #USER_GROUP#

    // Full raw payload as received, for debugging/reprocessing if the
    // parsed fields above ever turn out to be insufficient.
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Deal", DealSchema);
