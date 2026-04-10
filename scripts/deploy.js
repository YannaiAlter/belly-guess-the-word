const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const [owner] = await ethers.getSigners();

  console.log("Deploying Belly jackpot contract with account:", owner.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(owner.address)), "ETH\n");

  const BellyJackpot = await ethers.getContractFactory("BellyJackpot");
  const contract = await BellyJackpot.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("Belly jackpot contract deployed to:", address);

  // Write contract address + ABI to frontend so the UI can load it
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/BellyJackpot.sol/BellyJackpot.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const deployedNetwork = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const contractInfo = {
    address,
    abi: artifact.abi,
    network: networkName,
    chainId: Number(deployedNetwork.chainId),
    deployedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "../frontend/contract.json");
  fs.writeFileSync(outPath, JSON.stringify(contractInfo, null, 2));
  console.log("Contract info written to frontend/contract.json\n");

  if (networkName === "localhost" || networkName === "hardhat") {
    // Print helpful MetaMask setup info
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  MetaMask Setup — Add Hardhat Network");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Network Name : Hardhat Local");
    console.log("  RPC URL      : http://127.0.0.1:8545");
    console.log("  Chain ID     : 31337");
    console.log("  Currency     : ETH (acts as iKAS in local mode)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Print test accounts
    const signers = await ethers.getSigners();
    console.log("Test accounts (import one into MetaMask):");
    const hardhatAccounts = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    ];
    for (let i = 0; i < 3; i++) {
      const bal = ethers.formatEther(await ethers.provider.getBalance(signers[i].address));
      console.log(`  [${i}] ${signers[i].address}  (${bal} ETH)`);
      console.log(`      Private key: ${hardhatAccounts[i]}`);
    }
    console.log("\nAccount [0] is the jackpot owner.");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    console.log("Next: npm run serve  →  open http://localhost:3000");
  } else {
    console.log(`Deployed for network "${networkName}" (chainId: ${Number(deployedNetwork.chainId)}).`);
    console.log("Next: npm run serve:production  →  open http://localhost:3000");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
