// utils/sendWhatsAppOTP.js

const axios = require("axios");
require("dotenv").config();

/**
 * Sends an OTP to a WhatsApp number using the Teleobi API
 *
 * @param {string} phone - WhatsApp phone number with country code (e.g., "971XXXXXXXXX")
 * @param {string} otp - The OTP value to send (used in the template as a variable)
 * @returns {Promise<{ success: boolean, message?: string, error?: string, details?: any }>}
 */
const sendWhatsAppOTP = async (phone, otp) => {
  try {
    const apiUrl = "https://dash.teleobi.com/api/v1/whatsapp/send/template";

    const payload = new URLSearchParams({
      apiToken: process.env.TELEOBI_API_TOKEN, // move to .env in production
      phone_number_id: process.env.TELEOBO_NUMBER_ID,
      template_id: "212917", // Updated template ID
      phone_number: phone,
      "templateVariable-OTP-1": otp, // Dynamic OTP variable
    });

    const response = await axios.post(apiUrl, payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (response.data.success) {
      return { success: true, message: "OTP sent successfully." };
    } else {
      return {
        success: false,
        error: "API response failed.",
        details: response.data,
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = sendWhatsAppOTP;
