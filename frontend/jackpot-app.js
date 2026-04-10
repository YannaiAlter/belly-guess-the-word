/* global ethers */
let provider = null, signer = null, contract = null, currentAccount = null, ownerAddress = null;
let readProvider = null, readContract = null;
const state = { roundId: 0n, isRoundActive: false, roundEndsAt: 0n, entryFeeWei: 0n, roundDuration: 0n, feeBps: 0, potBalance: 0n, participantCount: 0n, winner: null, winnerTicket: 0n, finalized: false, timeRemaining: 0n };
let timerInterval = null;
let refreshInterval = null;
const byId = (id) => document.getElementById(id);
const setText = (id, v) => { const el = byId(id); if (el) el.textContent = v; };
const short = (a) => (!a ? '--' : `${a.slice(0,6)}...${a.slice(-4)}`);
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
function renderDashboard(){setText('round-id',state.roundId.toString());setText('entry-fee',`${ethers.formatEther(state.entryFeeWei)} iKAS`);setText('participant-count',state.participantCount.toString());setText('time-remaining',formatDuration(state.timeRemaining));setText('fee-bps',String(state.feeBps));setText('winner-addr',state.winner&&state.winner!==ethers.ZeroAddress?short(state.winner):'--');setText('winner-ticket',state.winnerTicket>0n?state.winnerTicket.toString():'--');setText('jackpot-hero-amount',`${ethers.formatEther(state.potBalance)} iKAS`);setText('round-status',state.isRoundActive?'Active':(state.finalized?'Finalized':'Waiting for owner'));byId('btn-join').disabled=!state.isRoundActive;renderFinalizeVisibility();}
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
  Object.assign(state,parseRoundState(await readContract.getRoundState()));
  renderDashboard();
  startUiTimer();
  await refreshWalletBalance();
  await renderParticipantsTable();
  if(currentAccount&&contract&&state.roundId>0n){const t=await readContract.getMyTicket(state.roundId,currentAccount);setText('my-ticket',t>0n?t.toString():'Not joined');}else setText('my-ticket','Not joined');
}
async function loadReadContract(){
  const res=await fetch('./contract.json');
  if(!res.ok)throw new Error('Failed to load contract.json');
  const info=await res.json();
  if (window.ethereum) {
    readProvider = new ethers.BrowserProvider(window.ethereum);
  } else {
    readProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  }
  readContract = new ethers.Contract(info.address,info.abi,readProvider);
}
async function loadWriteContract(){const res=await fetch('./contract.json');if(!res.ok)throw new Error('Failed to load contract.json');const info=await res.json();contract=new ethers.Contract(info.address,info.abi,signer);ownerAddress=await contract.owner();}
function setConnectedUI(connected) {
  byId("btn-connect").classList.toggle("hidden", connected);
  byId("btn-logout").classList.toggle("hidden", !connected);
}
async function connectWallet(){if(!window.ethereum){alert('No wallet found. Install MetaMask or KasWare EVM.');return;}provider=new ethers.BrowserProvider(window.ethereum);await provider.send('eth_requestAccounts',[]);signer=await provider.getSigner();currentAccount=await signer.getAddress();setText('wallet-addr',short(currentAccount));setConnectedUI(true);await loadWriteContract();if(!readContract){await loadReadContract();}renderRoleUI();await refreshState();}
function logoutWallet() {
  stopUiTimer();
  provider = null; signer = null; contract = null; currentAccount = null; ownerAddress = null;
  Object.assign(state, { roundId: 0n, isRoundActive: false, roundEndsAt: 0n, entryFeeWei: 0n, roundDuration: 0n, feeBps: 0, potBalance: 0n, participantCount: 0n, winner: null, winnerTicket: 0n, finalized: false, timeRemaining: 0n });
  setConnectedUI(false);
  setText("wallet-addr", "Not connected");
  setText("wallet-balance", "--");
  setText("my-ticket", "Not joined");
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
loadReadContract().then(() => refreshState()).catch(() => {});
refreshInterval = setInterval(()=>{if(readContract)refreshState().catch(()=>{});},5000);
