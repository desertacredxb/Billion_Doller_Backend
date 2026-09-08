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
// function encryptDataCrypto(data) {
//   try {
//     const text = typeof data === "string" ? data : JSON.stringify(data);
//     const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(CRYPTO_KEY), Buffer.from(CRYPTO_IV));
//     let encrypted = cipher.update(text, "utf8", "base64");
//     encrypted += cipher.final("base64");
//     return encrypted;
//   } catch (err) {
//     console.error("Crypto Encryption Error:", err.message);
//     return false;
//   }
// }

// function decryptDataCrypto(base64Data) {
//   try {
//     const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(CRYPTO_KEY), Buffer.from(CRYPTO_IV));
//     let decrypted = decipher.update(base64Data, "base64", "utf8");
//     decrypted += decipher.final("utf8");
//     return JSON.parse(decrypted);
//   } catch (err) {
//     console.error("Crypto Decryption Error:", err.message);
//     return false;
//   }
// }


const KEY_STRING = (process.env.CRYPTO_SECRET_KEY || "").trim();
const IV_STRING = (process.env.CRYPTO_SECRET_IV || "").trim();

function encryptDataCrypto(data) {
  try {
    // 1. Convert payload to clean JSON string
    const text = typeof data === "string" ? data : JSON.stringify(data);

    // 2. Create buffers with explicit UTF-8 encoding
    const key = Buffer.from(KEY_STRING, "utf8");
    const iv = Buffer.from(IV_STRING, "utf8");

    // 3. Encrypt using aes-256-cbc
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    let encrypted = cipher.update(text, "utf8", "base64");
    encrypted += cipher.final("base64");

    return encrypted;
  } catch (err) {
    console.error("Crypto Encryption Error:", err.message);
    return false;
  }
}

function decryptDataCrypto(base64Data) {
  try {
    if (!base64Data || typeof base64Data !== "string") return false;

    const key = Buffer.from(KEY_STRING, "utf8");
    const iv = Buffer.from(IV_STRING, "utf8");

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(base64Data, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  } catch (err) {
    console.error("Crypto Decryption Error:", err.message);
    return false;
  }
}

module.exports = {
  encryptData,
  decryptData,
  encryptDataCrypto,
  decryptDataCrypto,
};