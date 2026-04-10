/* global ethers */
let provider = null, signer = null, contract = null, currentAccount = null, ownerAddress = null;
let readProvider = null, readContract = null;
let contractInfo = null;
const state = { roundId: 0n, isRoundActive: false, roundEndsAt: 0n, entryFeeWei: 0n, roundDuration: 0n, feeBps: 0, potBalance: 0n, participantCount: 0n, winner: null, winnerTicket: 0n, finalized: false, timeRemaining: 0n };
let timerInterval = null;
let refreshInterval = null;
let firstDataLoadDone = false;
const byId = (id) => document.getElementById(id);
const setText = (id, v) => { const el = byId(id); if (el) el.textContent = v; };
const short = (a) => (!a ? '--' : `${a.slice(0,6)}...${a.slice(-4)}`);
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function setAppLoader(visible, message = "Loading jackpot data...") {
  const loader = byId("app-loader");
  const text = byId("app-loader-text");
  if (text) text.textContent = message;
  if (loader) loader.classList.toggle("hidden", !visible);
}
function getInjectedProviders() {
  if (window.ethereum?.providers && Array.isArray(window.ethereum.providers)) return window.ethereum.providers;
  return window.ethereum ? [window.ethereum] : [];
}
async function getClientVersionSafe(provider) {
  try {
    if (!provider?.request) return "";
    const v = await provider.request({ method: "web3_clientVersion" });
    return String(v || "").toLowerCase();
  } catch {
    return "";
  }
}
async function resolveWalletProvider(walletType) {
  const kaswareGlobal = window.kasware?.ethereum || null;
  const kastleGlobal = window.kastle?.ethereum || window.kastleEthereum || null;
  const candidates = [...new Set([kaswareGlobal, kastleGlobal, ...getInjectedProviders()].filter(Boolean))];

  if (!candidates.length) return null;

  const scored = await Promise.all(candidates.map(async (p) => {
    const client = await getClientVersionSafe(p);
    let score = 0;

    if (walletType === "kasware") {
      if (p === kaswareGlobal) score += 120;
      if (p.isKasware || p.isKasWare) score += 60;
      if (client.includes("kasware")) score += 80;
      if (p.isMetaMask || client.includes("metamask")) score -= 120;
      if (p === kastleGlobal || p.isKastle || p.isKastleWallet || client.includes("kastle")) score -= 120;
    }
    if (walletType === "metamask") {
      if (p.isMetaMask) score += 80;
      if (client.includes("metamask")) score += 100;
      if (p === kaswareGlobal || p.isKasware || p.isKasWare || client.includes("kasware")) score -= 120;
      if (p === kastleGlobal || p.isKastle || p.isKastleWallet || client.includes("kastle")) score -= 120;
    }
    if (walletType === "kastle") {
      if (p === kastleGlobal) score += 120;
      if (p.isKastle || p.isKastleWallet) score += 60;
      if (client.includes("kastle")) score += 80;
      if (p === kaswareGlobal || p.isKasware || p.isKasWare || client.includes("kasware")) score -= 120;
      if (p.isMetaMask || client.includes("metamask")) score -= 120;
    }

    return { provider: p, score };
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].provider : null;
}
function formatDuration(secBigInt){const sec=Number(secBigInt);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h>0?`${h}h ${m}m ${s}s`:m>0?`${m}m ${s}s`:`${s}s`;}
function parseRoundState(raw){return {roundId:raw[0],isRoundActive:raw[1],roundEndsAt:raw[2],entryFeeWei:raw[3],roundDuration:raw[4],feeBps:Number(raw[5]),potBalance:raw[6],participantCount:raw[7],winner:raw[8],winnerTicket:raw[9],finalized:raw[10],timeRemaining:raw[11]};}
function stopUiTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}
function startUiTimer() {
  stopUiTimer();
  timerInterval = setInterval(() => {
    if (state.isRoundActive && state.timeRemaining > 0n) {
      state.timeRemaining -= 1n;
      setText("time-remaining", formatDuration(state.timeRemaining));
      renderFinalizeVisibility();
    }
  }, 1000);
}
function renderRoleUI(){const isOwner=currentAccount&&ownerAddress&&currentAccount.toLowerCase()===ownerAddress.toLowerCase();const rp=byId('role-pill');const op=byId('owner-panel');if(rp){rp.textContent=isOwner?'Owner Controls Enabled':'Regular User';rp.className=`pill ${isOwner?'owner':'user'}`;}if(op)op.style.display=isOwner?'block':'none';}
function renderFinalizeVisibility() {
  const showFinalize = state.isRoundActive && state.timeRemaining === 0n && state.participantCount > 0n;
  byId("btn-finalize").classList.toggle("hidden", !showFinalize);
}
function renderDashboard(){setText('round-id',state.roundId.toString());setText('entry-fee',`${ethers.formatEther(state.entryFeeWei)} iKAS`);setText('participant-count',state.participantCount.toString());setText('time-remaining',formatDuration(state.timeRemaining));setText('fee-bps',String(state.feeBps));setText('winner-addr',state.winner&&state.winner!==ethers.ZeroAddress?short(state.winner):'--');setText('winner-ticket',state.winnerTicket>0n?state.winnerTicket.toString():'--');setText('jackpot-hero-amount',`${ethers.formatEther(state.potBalance)} iKAS`);setText('round-status',state.isRoundActive?'Active':(state.finalized?'Finalized':'Waiting for owner'));const joinBtn=byId('btn-join');if(joinBtn){joinBtn.classList.toggle('hidden',!(!!currentAccount&&!!contract));joinBtn.disabled=!(state.isRoundActive&&!!currentAccount&&!!contract);}renderFinalizeVisibility();}
async function renderParticipantsTable() {
  const tbody = byId("participants-table-body");
  if (!tbody || !readContract) return;
  if (state.roundId === 0n || state.participantCount === 0n) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);">No participants yet.</td></tr>';
    return;
  }

  // Source of truth: contract storage (never rely only on logs).
  const count = Number(state.participantCount);
  const participants = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const address = await readContract.getParticipantAt(i);
      const ticket = await readContract.getMyTicket(state.roundId, address);
      return { index: i + 1, address, ticket: ticket.toString() };
    })
  );

  tbody.innerHTML = participants.map((p) => `<tr>
    <td>${p.index}</td>
    <td class="mono">${p.address}</td>
    <td class="mono">${p.ticket}</td>
  </tr>`).join("");
}
async function refreshWalletBalance() {
  if (!provider || !currentAccount) { setText("wallet-balance", "--"); return; }
  const bal = await provider.getBalance(currentAccount);
  setText("wallet-balance", `${Number(ethers.formatEther(bal)).toFixed(4)} iKAS`);
}
async function refreshState(){
  if(!readContract) return;
  try {
    Object.assign(state,parseRoundState(await readContract.getRoundState()));
    renderDashboard();
    startUiTimer();
    await refreshWalletBalance();
    await renderParticipantsTable();
    if(currentAccount&&contract&&state.roundId>0n){const t=await readContract.getMyTicket(state.roundId,currentAccount);setText('my-ticket',t>0n?t.toString():'Not joined');}else setText('my-ticket','Not joined');
    firstDataLoadDone = true;
    setAppLoader(false);
  } catch (err) {
    setText("data-source", "Unavailable");
    setAppLoader(false);
  }
}
async function loadContractInfo() {
  if (contractInfo) return contractInfo;
  const res = await fetch('./contract.json');
  if (!res.ok) throw new Error('Failed to load contract.json');
  contractInfo = await res.json();
  return contractInfo;
}
async function loadReadContract(){
  const info = await loadContractInfo();
  const isLocal = Number(info.chainId || 0) === 31337 || info.network === "localhost";
  const rpcCandidates = [];
  if (info.rpcUrl) rpcCandidates.push(info.rpcUrl);
  rpcCandidates.push(isLocal ? "http://127.0.0.1:8545" : "https://rpc.igra.network");

  // First try JSON-RPC endpoints.
  for (const rpcUrl of rpcCandidates) {
    try {
      const candidateProvider = new ethers.JsonRpcProvider(rpcUrl);
      const candidateContract = new ethers.Contract(info.address, info.abi, candidateProvider);
      await withTimeout(candidateContract.getRoundState(), 7000, `rpc read ${rpcUrl}`);
      readProvider = candidateProvider;
      readContract = candidateContract;
      setText("data-source", rpcUrl.replace("https://", "").replace("http://", ""));
      return;
    } catch {
      // try next candidate
    }
  }

  // Fallback: use injected provider for read-only queries.
  if (window.ethereum) {
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const candidateContract = new ethers.Contract(info.address, info.abi, browserProvider);
      await withTimeout(candidateContract.getRoundState(), 7000, "wallet read");
      readProvider = browserProvider;
      readContract = candidateContract;
      setText("data-source", "Wallet RPC");
      return;
    } catch {
      // fall through to unavailable
    }
  }

  readProvider = null;
  readContract = null;
  setText("data-source", "Unavailable");
  throw new Error("No readable provider available");
}
async function loadWriteContract(){
  const info = await loadContractInfo();
  contract = new ethers.Contract(info.address,info.abi,signer);
  ownerAddress = await contract.owner();
}
function setConnectedUI(connected) {
  const authIcons = byId("wallet-auth-icons");
  if (authIcons) {
    authIcons.classList.toggle("hidden", connected);
    authIcons.style.display = connected ? "none" : "flex";
  }
  const topbar = byId("wallet-topbar");
  if (topbar) topbar.style.display = connected ? "inline-flex" : "none";
  const joinBtn = byId("btn-join");
  if (joinBtn) {
    joinBtn.classList.toggle("hidden", !connected);
    if (!connected) joinBtn.disabled = true;
  }
}
async function connectWallet(walletType){
  const injected = await resolveWalletProvider(walletType);
  if (!injected) {
    alert(`${walletType || "Selected"} wallet not found in this browser.`);
    return;
  }
  provider=new ethers.BrowserProvider(injected);
  await provider.send('eth_requestAccounts',[]);
  signer=await provider.getSigner();
  currentAccount=await signer.getAddress();
  setText('wallet-addr',short(currentAccount));
  setConnectedUI(true);
  await loadContractInfo();
  await loadReadContract();
  await loadWriteContract();
  renderRoleUI();
  await refreshState();
}
function logoutWallet() {
  stopUiTimer();
  provider = null; signer = null; contract = null; currentAccount = null; ownerAddress = null;
  Object.assign(state, { roundId: 0n, isRoundActive: false, roundEndsAt: 0n, entryFeeWei: 0n, roundDuration: 0n, feeBps: 0, potBalance: 0n, participantCount: 0n, winner: null, winnerTicket: 0n, finalized: false, timeRemaining: 0n });
  setConnectedUI(false);
  setText("wallet-addr", "Not connected");
  setText("wallet-balance", "--");
  setText("my-ticket", "Not joined");
  const joinBtn = byId("btn-join");
  if (joinBtn) joinBtn.disabled = true;
  renderRoleUI();
  renderDashboard();
  const tbody = byId("participants-table-body");
  if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);">Loading participants...</td></tr>';
  if (readContract) refreshState().catch(() => {});
}
async function waitTx(txp){const tx=await txp;await tx.wait();await refreshState();}
async function joinJackpot(){if(!contract){alert('Connect wallet first.');return;}try{await waitTx(contract.joinJackpot({value:state.entryFeeWei}));}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Join failed');}}
async function finalizeJackpot(){if(!contract){alert('Connect wallet first.');return;}try{await waitTx(contract.finalizeJackpot());}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Finalize failed');}}
async function startRound(){if(!contract){alert('Connect wallet first.');return;}try{await waitTx(contract.startNewRound());}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Start round failed');}}
async function setEntryFee(){if(!contract){alert('Connect wallet first.');return;}const v=byId('new-entry-fee').value.trim();if(!v)return;try{await waitTx(contract.setEntryFee(ethers.parseEther(v)));}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Set entry fee failed');}}
async function setRoundDuration(){if(!contract){alert('Connect wallet first.');return;}const v=byId('new-duration').value.trim();if(!v)return;try{await waitTx(contract.setRoundDuration(BigInt(v)));}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Set duration failed');}}
async function setFeeBps(){if(!contract){alert('Connect wallet first.');return;}const v=byId('new-fee-bps').value.trim();if(!v)return;try{await waitTx(contract.setFeeBps(Number(v)));}catch(e){alert(e?.reason||e?.shortMessage||e?.message||'Set fee bps failed');}}
window.connectWallet=connectWallet;window.logoutWallet=logoutWallet;window.joinJackpot=joinJackpot;window.finalizeJackpot=finalizeJackpot;window.startRound=startRound;window.setEntryFee=setEntryFee;window.setRoundDuration=setRoundDuration;window.setFeeBps=setFeeBps;
setAppLoader(true, "Loading jackpot data...");
loadReadContract()
  .then(() => refreshState())
  .catch(() => { setText("data-source", "Unavailable"); setAppLoader(false); });
refreshInterval = setInterval(async () => {
  try {
    if (!readContract) await loadReadContract();
    if (readContract) await refreshState();
  } catch {
    setText("data-source", "Unavailable");
    setAppLoader(false);
  }
}, 5000);
