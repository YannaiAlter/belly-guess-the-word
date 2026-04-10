require("@nomicfoundation/hardhat-toolbox");

// Load .env if present (needed for IGRA mainnet deployment)
try { require("dotenv").config(); } catch { /* dotenv not installed — fine for local dev */ }

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    // ── Local development ──────────────────────────────────────────────────
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // ── IGRA Network mainnet ───────────────────────────────────────────────
    // Requires PRIVATE_KEY, IGRA_RPC_URL, and IGRA_CHAIN_ID in .env
    igra: {
      url:      process.env.IGRA_RPC_URL  || "https://rpc.igra.network",
      chainId:  parseInt(process.env.IGRA_CHAIN_ID || "0"),
      accounts: process.env.PRIVATE_KEY   ? [process.env.PRIVATE_KEY] : [],
      // IGRA RPC enforces a 1,000,000,000,000 wei minimum gas fee.
      gasPrice: 1000000000000,
    },
  },

  etherscan: {
    apiKey: {
      igra: process.env.IGRA_EXPLORER_API_KEY || "abc",
    },
    customChains: [
      {
        network: "igra",
        chainId: 38833,
        urls: {
          apiURL: "https://explorer.igralabs.com/api",
          browserURL: "https://explorer.igralabs.com",
        },
      },
    ],
  },

  // Gas reporter (optional — npm install --save-dev hardhat-gas-reporter)
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
