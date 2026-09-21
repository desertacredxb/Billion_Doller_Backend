const mongoose = require("mongoose");

// Reusable KYC document sub-schema — one ID proof is { docType, docNumber, image }.
// Embedded twice on User (idProof1 required, idProof2 optional) instead of being
// inlined field-by-field on the main schema.
const idProofSchema = new mongoose.Schema(
  {
    docType: { type: String, default: null },
    docNumber: { type: String, default: null },
    image: { type: String, default: null },
  },
  { _id: false }
);

module.exports = idProofSchema;
