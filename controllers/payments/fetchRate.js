const axios = require("axios");

// Fetch the current INR -> USD conversion rate (1 INR = ? USD)
async function fetchRate() {
  try {
    const res = await axios.get(
      "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD"
    );
    return res.data.rates.USD;
  } catch (err) {
    console.error("Error fetching INR→USD rate:", err.message);
    return 0.012; // fallback rate if API fails
  }
}

module.exports = fetchRate;
