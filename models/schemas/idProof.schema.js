const mongoose = require("mongoose");

// One government ID, with an optional back photo of that same document.
const idProofSchema = new mongoose.Schema(
  {
    docType: { type: String, default: null },
    docNumber: { type: String, default: null },
    issuingCountry: { type: String, default: null },
    image: { type: String, default: null },
    backImage: { type: String, default: null },
  },
  { _id: false }
);

module.exports = idProofSchema;
