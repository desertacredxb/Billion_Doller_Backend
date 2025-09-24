// utils/rameeCrypto.js
const crypto = require("crypto");
require("dotenv").config();

const IV = process.env.RAMEEPAY_SECRET_IV; // fixed 16-byte IV
const KEY = process.env.RAMEEPAY_SECRET_KEY; // must be 32 bytes for aes-256-cbc

// AES-256-CBC encryption
function encryptData(data) {
  try {
    const text = JSON.stringify(data);
    const cipher = crypto.createCipheriv("aes-256-cbc", KEY, IV);
    let encrypted = cipher.update(text, "utf8", "base64");
    encrypted += cipher.final("base64");
    return encrypted;
  } catch (error) {
    console.error("Encryption Error:", error.message);
    return false;
  }
}

// AES-256-CBC decryption
function decryptData(encryptedText) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, IV);
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch (error) {
    console.error("Decryption Error:", error.message);
    return false;
  }
}

module.exports = { encryptData, decryptData };
