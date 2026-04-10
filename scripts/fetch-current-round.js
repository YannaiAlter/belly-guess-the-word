const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  const contractInfoPath = path.join(__dirname, "../frontend/contract.json");
  const contractInfo = JSON.parse(fs.readFileSync(contractInfoPath, "utf8"));

  const defaultRpc =
    Number(contractInfo.chainId) === 31337
      ? "http://127.0.0.1:8545"
      : "https://rpc.igralabs.com:8545";

  const rpcUrl = process.env.IGRA_RPC_URL || defaultRpc;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractInfo.address, contractInfo.abi, provider);

  const [
    roundId,
    isRoundActive,
    roundEndsAt,
    entryFeeWei,
    roundDuration,
    feeBps,
    potBalance,
    participantCount,
    winner,
    winnerTicket,
    finalized,
    timeRemaining,
  ] = await contract.getRoundState();

  const out = {
    address: contractInfo.address,
    chainId: Number(contractInfo.chainId),
    network: contractInfo.network,
    roundId: roundId.toString(),
    isRoundActive,
    roundEndsAt: roundEndsAt.toString(),
    entryFeeIgas: ethers.formatEther(entryFeeWei),
    roundDurationSeconds: roundDuration.toString(),
    feeBps: Number(feeBps),
    potIgas: ethers.formatEther(potBalance),
    participantCount: participantCount.toString(),
    winner,
    winnerTicket: winnerTicket.toString(),
    finalized,
    timeRemainingSeconds: timeRemaining.toString(),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("Failed to fetch current round:");
  console.error(err);
  process.exit(1);
});
