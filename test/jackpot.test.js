const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WordGuessing (Jackpot mode)", function () {
  async function deployFixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("WordGuessing");
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    return { contract, owner, alice, bob, carol };
  }

  it("starts with jackpot defaults", async function () {
    const { contract, owner } = await deployFixture();
    expect(await contract.owner()).to.equal(owner.address);
    expect(await contract.entryFeeWei()).to.equal(ethers.parseEther("10"));
    expect(await contract.roundDuration()).to.equal(2 * 60 * 60);
    expect(await contract.feeBps()).to.equal(500);
  });

  it("only owner can configure and start round", async function () {
    const { contract, alice } = await deployFixture();
    await expect(contract.connect(alice).setEntryFee(1)).to.be.reverted;
    await expect(contract.connect(alice).setRoundDuration(3600)).to.be.reverted;
    await expect(contract.connect(alice).setFeeBps(100)).to.be.reverted;
    await expect(contract.connect(alice).startNewRound()).to.be.reverted;
  });

  it("enforces owner fee cap", async function () {
    const { contract } = await deployFixture();
    await expect(contract.setFeeBps(1001)).to.be.revertedWith("Jackpot: fee exceeds max cap");
    await expect(contract.setFeeBps(1000)).to.not.be.reverted;
  });

  it("joins with exact entry fee and blocks duplicate join", async function () {
    const { contract, alice } = await deployFixture();
    await contract.startNewRound();
    await expect(contract.connect(alice).joinJackpot({ value: ethers.parseEther("9") })).to.be.revertedWith(
      "Jackpot: incorrect entry fee"
    );
    await contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") });
    await expect(contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") })).to.be.revertedWith(
      "Jackpot: already joined this round"
    );
  });

  it("cannot finalize before deadline", async function () {
    const { contract, alice } = await deployFixture();
    await contract.startNewRound();
    await contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") });
    await expect(contract.finalizeJackpot()).to.be.revertedWith("Jackpot: round not ended");
  });

  it("finalizes after deadline and always selects valid winner", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.startNewRound();
    await contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") });
    await contract.connect(bob).joinJackpot({ value: ethers.parseEther("10") });

    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    const tx = await contract.finalizeJackpot();
    await tx.wait();

    const state = await contract.getRoundState();
    const winner = state[8];
    const winnerIndex = await contract.winnerIndex();
    expect(winner).to.not.equal(ethers.ZeroAddress);
    expect(winnerIndex).to.be.oneOf([0n, 1n]);
    expect(await contract.isRoundActive()).to.equal(false);
    expect(await contract.potBalance()).to.equal(0n);
  });

  it("pays winner and owner fee correctly", async function () {
    const { contract, owner, alice, bob } = await deployFixture();
    await contract.startNewRound();
    await contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") });
    await contract.connect(bob).joinJackpot({ value: ethers.parseEther("10") });

    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const bobBefore = await ethers.provider.getBalance(bob.address);

    const tx = await contract.finalizeJackpot();
    await tx.wait();

    const ownerAfter = await ethers.provider.getBalance(owner.address);
    const aliceAfter = await ethers.provider.getBalance(alice.address);
    const bobAfter = await ethers.provider.getBalance(bob.address);

    const ownerGain = ownerAfter - ownerBefore;
    const aliceGain = aliceAfter - aliceBefore;
    const bobGain = bobAfter - bobBefore;
    const expectedOwnerFee = ethers.parseEther("1");
    const minOwnerNet = ethers.parseEther("0.95");

    expect(ownerGain).to.be.greaterThan(minOwnerNet);
    expect(ownerGain).to.be.lessThanOrEqual(expectedOwnerFee);
    expect(aliceGain > ethers.parseEther("8") || bobGain > ethers.parseEther("8")).to.equal(true);
  });

  it("allows new round after finalization", async function () {
    const { contract, alice } = await deployFixture();
    await contract.startNewRound();
    await contract.connect(alice).joinJackpot({ value: ethers.parseEther("10") });
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await contract.finalizeJackpot();

    await expect(contract.startNewRound()).to.not.be.reverted;
    expect(await contract.roundId()).to.equal(2n);
  });

  it("rejects direct ETH transfers to contract", async function () {
    const { contract, alice } = await deployFixture();
    await expect(
      alice.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther("1")
      })
    ).to.be.revertedWith("Jackpot: direct payments disabled");
  });
});
