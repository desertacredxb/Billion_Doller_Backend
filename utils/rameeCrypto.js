// utils/rameeCrypto.js
const crypto = require("crypto");
require("dotenv").config();

const KEY = process.env.RAMEEPAY_SECRET_KEY; // Must be 32 bytes
const IV = process.env.RAMEEPAY_SECRET_IV;   // Must be 16 bytes

const CRYPTO_KEY = process.env.CRYPTO_SECRET_KEY || KEY; // Must be 32 bytes
const CRYPTO_IV = process.env.CRYPTO_SECRET_IV || IV;     // Must be 16 bytes

function encryptData(data) {
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(KEY), Buffer.from(IV));
    let encrypted = cipher.update(text, "utf8", "base64");
    encrypted += cipher.final("base64");
    return encrypted;
  } catch (error) {
    console.error("Encryption Error:", error.message);
    return false;
  }
}

function decryptData(encryptedText) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(KEY), Buffer.from(IV));
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch (error) {
    console.error("Decryption Error:", error.message);
    return false;
  }
}

// Crypto methods using AES-256-CBC with CRYPTO keys
function encryptDataCrypto(data) {
  try {
    const iv = crypto.randomBytes(12); // ✔ must be 12 bytes
    console.log(iv);
    const jsonString = JSON.stringify(data);
    console.log(jsonString);
    const cipher = crypto.createCipheriv("aes-256-gcm", CRYPTO_KEY, iv);

    let encrypted = cipher.update(jsonString, "utf8", "base64");
    encrypted += cipher.final("base64");

    const authTag = cipher.getAuthTag(); // 16 bytes

    // 👇 RAMEE format:  IV + AuthTag + EncryptedData
    const combined = Buffer.concat([
      iv, // 12 bytes
      authTag, // 16 bytes
      Buffer.from(encrypted, "base64"), // encrypted payload
    ]);

    return combined.toString("base64");
  } catch (err) {
    console.error("Encryption error:", err);
    return false;
  }
}

// ------------------------------------------------------
// 🔓 AES-256-GCM Decryption
// ------------------------------------------------------
function decryptDataCrypto(base64Data) {
  try {
    const combined = Buffer.from(base64Data, "base64");

    const iv = combined.slice(0, 12); // ✔ first 12 bytes
    const authTag = combined.slice(12, 28); // ✔ next 16 bytes
    const encryptedData = combined.slice(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", CRYPTO_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, undefined, "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  } catch (err) {
    console.error("Decryption error:", err);
    return false;
  }
}

module.exports = {
  encryptData,
  decryptData,
  encryptDataCrypto,
  decryptDataCrypto,
};