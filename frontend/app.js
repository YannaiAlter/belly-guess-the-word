/**
 * Belly — IGRA Network
 * Frontend logic: wallet connection, contract interaction, UI updates.
 * Wallet support: KasWare (window.kasware.ethereum) + MetaMask (window.ethereum)
 * ethers.js v6
 */

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let provider       = null;
let signer         = null;
let contract       = null;
let contractInfo   = null;
let ownerAddress   = null;
let currentAccount = null;
let activeWallet   = null; // 'kasware' | 'metamask' | 'dev'

const COOLDOWN_SECS   = 10;
const MAX_GUESSES     = 20;
let cooldownInterval  = null;
let refreshInterval   = null;
let activityTimer     = null;

// In-memory session data
let activities       = [];   // [{icon, msg, time, type}]
let sessionGuesses   = [];   // [{word, correct}]
let activityOpen     = true;

// ─────────────────────────────────────────────────────────────────────────────
// Toast Notifications
// ─────────────────────────────────────────────────────────────────────────────

const TOAST_ICONS = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };

function toast(msg, type = 'info', duration = 4500) {
  const container = document.getElementById('toasts');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast t-${type}`;
  el.innerHTML = `
    <span class="t-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
    <span class="t-msg">${msg}</span>
    <button class="t-close" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Feed
// ─────────────────────────────────────────────────────────────────────────────

function addActivity(icon, msg, type = 'info') {
  activities.unshift({ icon, msg, type, time: Date.now() });
  if (activities.length > 20) activities.length = 20;
  renderActivity();
  updateActivityCount();
}

function renderActivity() {
  const el = document.getElementById('activity-body');
  if (!el) return;

  if (activities.length === 0) {
    el.innerHTML = '<div class="act-empty">No activity yet.</div>';
    return;
  }

  el.innerHTML = activities.map(a => `
    <div class="act-item">
      <span class="act-ico">${a.icon}</span>
      <span class="act-msg">${a.msg}</span>
      <span class="act-time">${timeAgo(a.time)}</span>
    </div>
  `).join('');
}

function updateActivityCount() {
  const el = document.getElementById('act-count');
  if (!el) return;
  if (activities.length > 0) {
    el.textContent = activities.length;
    el.style.display = 'inline-block';
  }
}

function toggleActivity() {
  activityOpen = !activityOpen;
  const body    = document.getElementById('activity-body');
  const toggle  = document.getElementById('act-toggle');
  if (body)   body.classList.toggle('open', activityOpen);
  if (toggle) toggle.classList.toggle('open', activityOpen);
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5)    return 'just now';
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// Refresh time-ago labels every 30 seconds
function startActivityTimer() {
  clearInterval(activityTimer);
  activityTimer = setInterval(renderActivity, 30000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Guess History
// ─────────────────────────────────────────────────────────────────────────────

function addSessionGuess(word, correct) {
  sessionGuesses.unshift({ word, correct });
  renderSessionGuesses();
}

function renderSessionGuesses() {
  const container = document.getElementById('session-history');
  const tags      = document.getElementById('guess-tags');
  if (!container || !tags) return;

  if (sessionGuesses.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  tags.innerHTML = sessionGuesses.slice(0, 8).map(g =>
    `<span class="gtag${g.correct ? ' correct' : ''}">${g.word}</span>`
  ).join('');
}

function clearSessionGuesses() {
  sessionGuesses = [];
  renderSessionGuesses();
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Detection
// ─────────────────────────────────────────────────────────────────────────────

function getKasWareProvider() {
  return window?.kasware?.ethereum || null;
}

function getMetaMaskProvider() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  if (window.ethereum?.providers)  return window.ethereum.providers.find(p => p.isMetaMask) || null;
  return null;
}

function detectWallets() {
  return {
    kasware:  !!getKasWareProvider(),
    metamask: !!getMetaMaskProvider(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  // Load contract.json
  try {
    const res = await fetch('./contract.json');
    if (!res.ok) throw new Error('not found');
    contractInfo = await res.json();
  } catch {
    toast('contract.json not found — run: npm run deploy', 'error', 0);
    return;
  }

  // Detect wallets and update cards
  const detected = detectWallets();
  updateWalletCards(detected);

  // Attach wallet event listeners
  const kwp = getKasWareProvider();
  const mmp = getMetaMaskProvider();
  kwp?.on?.('accountsChanged', accounts => accounts.length ? connectWallet('kasware') : disconnect());
  kwp?.on?.('chainChanged',    () => window.location.reload());
  mmp?.on?.('accountsChanged', accounts => accounts.length ? connectWallet('metamask') : disconnect());
  mmp?.on?.('chainChanged',    () => window.location.reload());

  // Attach guess input events
  const guessInput = document.getElementById('input-guess');
  if (guessInput) {
    guessInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });
    guessInput.addEventListener('input',   e => updateCharHint(e.target.value));
  }

  // Auto-reconnect from session
  const saved = sessionStorage.getItem('walletType');
  if (saved === 'dev') {
    const pk = sessionStorage.getItem('devPK');
    if (pk) connectDev(pk);
  } else if (saved) {
    connectWallet(saved);
  }
});

function updateWalletCards(detected) {
  const kwSub  = document.getElementById('kasware-status');
  const mmSub  = document.getElementById('metamask-status');
  const kwCard = document.getElementById('card-kasware');
  const mmCard = document.getElementById('card-metamask');
  const hdrKw  = document.getElementById('hdr-kasware');
  const hdrMm  = document.getElementById('hdr-metamask');

  if (kwSub) {
    kwSub.textContent = detected.kasware ? 'Detected · click to connect' : 'Not installed';
    if (!detected.kasware) kwCard?.classList.add('unavailable');
  }
  if (mmSub) {
    mmSub.textContent = detected.metamask ? 'Detected · click to connect' : 'Not installed';
    if (!detected.metamask) mmCard?.classList.add('unavailable');
  }
  if (hdrKw) hdrKw.disabled = !detected.kasware;
  if (hdrMm) hdrMm.disabled = !detected.metamask;
}

function updateCharHint(val) {
  const el = document.getElementById('char-hint');
  if (!el) return;
  if (val.length > 0) {
    el.textContent = val.length + ' char' + (val.length === 1 ? '' : 's');
    el.style.display = 'inline';
  } else {
    el.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect / Disconnect
// ─────────────────────────────────────────────────────────────────────────────

async function connectWallet(walletType) {
  if (!contractInfo) {
    toast('Contract not deployed. Run: npm run deploy', 'error');
    return;
  }

  let rawProvider = null;
  if (walletType === 'kasware') {
    rawProvider = getKasWareProvider();
    if (!rawProvider) { toast('KasWare not found. Install from the Chrome Web Store.', 'error'); return; }
  } else if (walletType === 'metamask') {
    rawProvider = getMetaMaskProvider();
    if (!rawProvider) { toast('MetaMask not found. Install from the Chrome Web Store.', 'error'); return; }
  } else {
    rawProvider = getKasWareProvider() || getMetaMaskProvider();
    if (!rawProvider) { toast('No wallet detected. Install KasWare or MetaMask.', 'error'); return; }
    walletType  = getKasWareProvider() ? 'kasware' : 'metamask';
  }

  try {
    provider = new ethers.BrowserProvider(rawProvider);
    await provider.send('eth_requestAccounts', []);

    signer         = await provider.getSigner();
    currentAccount = await signer.getAddress();
    activeWallet   = walletType;

    const network = await provider.getNetwork();
    const walletChainId = Number(network.chainId);
    const expectedChainId = Number(contractInfo.chainId || 0);
    if (expectedChainId && walletChainId !== expectedChainId) {
      const expectedLabel = contractInfo.network
        ? `${contractInfo.network} (${expectedChainId})`
        : String(expectedChainId);
      toast(
        `Wrong network. Wallet is on chain ${walletChainId}, but contract.json expects ${expectedLabel}.`,
        'error',
        7000
      );
      return;
    }

    contract     = new ethers.Contract(contractInfo.address, contractInfo.abi, signer);
    ownerAddress = await contract.owner();

    sessionStorage.setItem('walletType', walletType);

    updateNetworkPill(walletChainId);
    updateWalletUI();
    showPanels();
    await refreshState();
    listenToContractEvents();
    startActivityTimer();

    clearInterval(refreshInterval);
    refreshInterval = setInterval(refreshState, 6000);

    const wName = walletType === 'kasware' ? 'KasWare' : 'MetaMask';
    toast(`Connected via ${wName}`, 'success');
    addActivity('🔗', `Connected: <strong>${short(currentAccount)}</strong> via ${wName}`);
    if (isOwner()) addActivity('👑', 'You are the contract owner');

  } catch (err) {
    const msg = err?.data?.originalError?.message || err?.reason || err?.message || String(err);
    toast(`Connection failed: ${msg}`, 'error');
  }
}

function disconnect() {
  provider = signer = contract = currentAccount = activeWallet = null;
  clearInterval(refreshInterval);
  clearInterval(cooldownInterval);
  clearInterval(activityTimer);
  sessionStorage.removeItem('walletType');
  sessionStorage.removeItem('devPK');

  activities     = [];
  sessionGuesses = [];

  const nc = document.getElementById('not-connected');
  const pn = document.getElementById('panels');
  if (nc) nc.style.display = 'block';
  if (pn) pn.style.display = 'none';

  const netPill    = document.getElementById('net-pill');
  const netName    = document.getElementById('net-name');
  const walletPill = document.getElementById('wallet-pill');
  const connectBtns = document.getElementById('header-connect-btns');
  const discBtn    = document.getElementById('btn-disconnect');

  if (netPill)    netPill.classList.remove('ok');
  if (netName)    netName.textContent = 'No wallet';
  if (walletPill) walletPill.style.display = 'none';
  if (connectBtns) connectBtns.style.display = 'flex';
  if (discBtn)    discBtn.style.display = 'none';

  toast('Disconnected', 'info');
}

async function connectDev(privateKey) {
  if (!contractInfo) { toast('Contract not deployed. Run: npm run deploy', 'error'); return; }
  if (!privateKey || privateKey.length < 10) { toast('Enter a valid private key.', 'warn'); return; }
  hideDevModal();

  try {
    const rpcProvider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
    const wallet      = new ethers.Wallet(privateKey, rpcProvider);

    provider       = rpcProvider;
    signer         = wallet;
    currentAccount = await wallet.getAddress();
    activeWallet   = 'dev';

    contract     = new ethers.Contract(contractInfo.address, contractInfo.abi, signer);
    ownerAddress = await contract.owner();

    sessionStorage.setItem('walletType', 'dev');
    sessionStorage.setItem('devPK', privateKey);

    updateNetworkPill(31337);
    updateWalletUI();
    showPanels();
    await refreshState();
    listenToContractEvents();
    startActivityTimer();

    clearInterval(refreshInterval);
    refreshInterval = setInterval(refreshState, 6000);

    toast(`Dev mode connected: ${short(currentAccount)}${isOwner() ? ' (owner)' : ''}`, 'success');
    addActivity('🔧', `Dev mode: <strong>${short(currentAccount)}</strong>${isOwner() ? ' — owner' : ''}`);

  } catch (err) {
    toast('Dev connect failed: ' + (err?.message || String(err)), 'error');
  }
}

function isOwner() {
  return !!(currentAccount && ownerAddress &&
    currentAccount.toLowerCase() === ownerAddress.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Game State
// ─────────────────────────────────────────────────────────────────────────────

async function refreshState() {
  if (!contract || !currentAccount) return;
  try {
    const [isActive, wordHash, hint, potBalance, winner, guessesCount, , timeRemaining] =
      await contract.getGameState();

    const myGuesses   = await contract.guessesPerAddress(currentAccount);
    const myLastGuess = await contract.lastGuessTimestamp(currentAccount);

    // Status banner
    updateStatusBanner(isActive, winner, potBalance, guessesCount, timeRemaining);

    // Hint
    const hintBox = document.getElementById('hint-box');
    if (hintBox) {
      if (hint && isActive) {
        hintBox.className = 'hint-box';
        hintBox.innerHTML = `<span style="color:var(--muted); font-size:11px; font-style:normal; display:block; margin-bottom:4px;">HINT</span>${hint}`;
      } else {
        hintBox.className = 'hint-box empty';
        hintBox.textContent = isActive ? 'No hint provided.' : 'Waiting for a game to start…';
      }
    }

    // Stats
    set('pot-balance',   ethers.formatEther(potBalance) + ' iKAS');
    set('guess-count',   guessesCount.toString());
    set('my-guesses',    myGuesses.toString() + ' / ' + MAX_GUESSES);
    set('time-remaining', isActive && timeRemaining > 0n
      ? formatTime(Number(timeRemaining))
      : isActive ? 'Expired' : '—');

    // Guess progress bar
    updateGuessProgress(Number(myGuesses));

    // Winner banner
    const winnerSection = document.getElementById('winner-section');
    if (winnerSection) {
      if (winner !== ethers.ZeroAddress) {
        winnerSection.style.display = 'block';
        set('winner-addr', winner);
      } else {
        winnerSection.style.display = 'none';
      }
    }

    // Guess panel visibility
    const gp   = document.getElementById('guess-panel');
    const gim  = document.getElementById('game-inactive-msg');
    if (gp)  gp.style.display  = isActive ? 'block' : 'none';
    if (gim) gim.style.display = isActive ? 'none'  : 'block';

    // Owner panel
    if (isOwner()) {
      const op = document.getElementById('owner-panel');
      if (op) op.style.display = 'block';
      const sf  = document.getElementById('start-game-form');
      const rf  = document.getElementById('reset-game-form');
      if (sf) sf.style.display = isActive ? 'none'  : 'block';
      if (rf) rf.style.display = (isActive && timeRemaining === 0n) ? 'block' : 'none';
    }

    // Cooldown
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (isActive && now < myLastGuess + BigInt(COOLDOWN_SECS)) {
      startCooldown(Number(myLastGuess + BigInt(COOLDOWN_SECS) - now));
    } else {
      clearCooldown();
    }

    // Balance
    const bal = await provider.getBalance(currentAccount);
    set('my-balance', ethers.formatEther(bal).slice(0, 8) + ' iKAS');

  } catch (err) {
    console.error('refreshState error:', err);
  }
}

function updateStatusBanner(isActive, winner, potBalance, guessesCount, timeRemaining) {
  const banner = document.getElementById('status-banner');
  const title  = document.getElementById('sb-title');
  const meta   = document.getElementById('sb-meta');
  if (!banner || !title || !meta) return;

  const hasWinner = winner !== ethers.ZeroAddress;

  banner.className = 'status-banner ' + (
    isActive   ? 'sb-active'   :
    hasWinner  ? 'sb-ended'    :
                 'sb-inactive'
  );

  if (isActive) {
    title.textContent = 'Game Active';
    meta.innerHTML = `
      <div class="sb-stat">💰 <strong>${ethers.formatEther(potBalance)} iKAS</strong> prize pool</div>
      <div class="sb-stat">⏱ <strong>${timeRemaining > 0n ? formatTime(Number(timeRemaining)) : 'Expired'}</strong> remaining</div>
      <div class="sb-stat">🎯 <strong>${guessesCount}</strong> total guesses</div>
    `;
  } else if (hasWinner) {
    title.textContent = 'Game Ended';
    meta.innerHTML = `<div class="sb-stat">Winner: <strong>${short(winner)}</strong></div>`;
  } else {
    title.textContent = 'No Active Game';
    meta.innerHTML = `<div class="sb-stat" style="color:var(--muted)">Waiting for the owner to start…</div>`;
  }
}

function updateGuessProgress(myGuesses) {
  const fill    = document.getElementById('prog-fill');
  const text    = document.getElementById('prog-text');
  if (!fill || !text) return;

  const pct = (myGuesses / MAX_GUESSES) * 100;
  fill.style.width = pct + '%';
  fill.className   = 'prog-fill' + (pct >= 100 ? ' danger' : pct >= 75 ? ' warn' : '');
  text.textContent = `${myGuesses} / ${MAX_GUESSES}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Actions
// ─────────────────────────────────────────────────────────────────────────────

async function startGame() {
  const secret = document.getElementById('input-secret')?.value.trim();
  const hint   = document.getElementById('input-hint')?.value.trim();
  if (!secret) { toast('Enter a secret word first.', 'warn'); return; }

  const wordHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

  setLoading('btn-start', 'btn-start-label', 'Starting…', true);
  try {
    const tx = await contract.startGame(wordHash, hint || '');
    await tx.wait();

    toast('Game started! Players can now guess.', 'success');
    addActivity('🚀', `New game started! Hint: <strong>${hint || '(none)'}</strong>`);

    document.getElementById('input-secret').value = '';
    document.getElementById('input-hint').value   = '';
    clearSessionGuesses();
    await refreshState();
  } catch (err) {
    const msg = err?.reason || err?.message;
    toast('Start game failed: ' + msg, 'error');
  }
  setLoading('btn-start', 'btn-start-label', '▶ Start Game', false);
}

async function submitGuess() {
  const guess = document.getElementById('input-guess')?.value.trim();
  if (!guess) { toast('Type a word first.', 'warn'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(guess)) {
    toast('Guess should be a single word (letters, numbers, hyphens).', 'warn');
    return;
  }

  setLoading('btn-guess', 'btn-guess-label', '…', true);
  try {
    const tx = await contract.submitGuess(guess, { value: ethers.parseEther('10') });
    const receipt = await tx.wait();

    let won = false;
    for (const logEntry of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(logEntry);
        if (parsed.name === 'WinnerDeclared') {
          won = true;
          const amount = ethers.formatEther(parsed.args.winnerAmount);
          toast(`🏆 You won! ${amount} iKAS sent to your wallet.`, 'success', 8000);
          showConfetti();
          addActivity('🏆', `<strong>${short(currentAccount)}</strong> won <strong>${amount} iKAS</strong>!`);
        } else if (parsed.name === 'GuessSubmitted') {
          const correct = parsed.args.correct;
          if (!correct) toast(`"${guess}" — not the word. Keep trying!`, 'warn');
          addActivity(
            correct ? '✅' : '❌',
            `<strong>${short(currentAccount)}</strong> guessed <em>${guess}</em> — ${correct ? 'correct!' : 'wrong'}`
          );
          addSessionGuess(guess, correct);
        }
      } catch { /* non-matching log */ }
    }

    if (!won) startCooldown(COOLDOWN_SECS);
    document.getElementById('input-guess').value = '';
    updateCharHint('');
    await refreshState();

  } catch (err) {
    const msg = err?.reason || err?.data?.message || err?.message;
    if (msg?.includes('cooldown')) {
      toast('Cooldown active — wait a moment before guessing again.', 'warn');
    } else if (msg?.includes('not active')) {
      toast('No game is active right now.', 'warn');
    } else if (msg?.includes('maximum guesses')) {
      toast('You have reached the 20-guess limit for this game.', 'warn');
    } else {
      toast('Guess failed: ' + msg, 'error');
    }
  }
  setLoading('btn-guess', 'btn-guess-label', 'Guess →', false);
}

async function resetTimedOut() {
  setLoading('btn-reset', null, null, true);
  try {
    const tx = await contract.resetTimedOutGame();
    await tx.wait();
    toast('Game reset. Pot reclaimed.', 'success');
    addActivity('🔄', 'Owner reset timed-out game and reclaimed the pot.');
    clearSessionGuesses();
    await refreshState();
  } catch (err) {
    toast('Reset failed: ' + (err?.reason || err?.message), 'error');
  }
  setLoading('btn-reset', null, null, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract Events
// ─────────────────────────────────────────────────────────────────────────────

function listenToContractEvents() {
  contract.on('GameStarted', (wordHash, hint) => {
    addActivity('🚀', `New game started! Hint: <strong>${hint || '(none)'}</strong>`);
    refreshState();
  });

  contract.on('GuessSubmitted', (player, totalGuesses, correct) => {
    if (player.toLowerCase() !== currentAccount.toLowerCase()) {
      addActivity(
        correct ? '✅' : '🎯',
        `<strong>${short(player)}</strong> guessed — ${correct ? 'correct!' : 'wrong'}`
      );
      refreshState();
    }
  });

  contract.on('WinnerDeclared', (winner, winnerAmount) => {
    const amount = ethers.formatEther(winnerAmount);
    if (winner.toLowerCase() !== currentAccount.toLowerCase()) {
      addActivity('🏆', `<strong>${short(winner)}</strong> won <strong>${amount} iKAS</strong>!`);
    }
    refreshState();
  });

  contract.on('GameReset', (owner, reclaimed) => {
    addActivity('🔄', `Game reset by owner. ${ethers.formatEther(reclaimed)} iKAS reclaimed.`);
    refreshState();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cooldown
// ─────────────────────────────────────────────────────────────────────────────

function startCooldown(seconds) {
  clearInterval(cooldownInterval);
  let remaining = Math.max(0, seconds);

  const wrap = document.getElementById('cooldown-wrap');
  const text = document.getElementById('cd-text');
  const bar  = document.getElementById('cd-bar');
  const btn  = document.getElementById('btn-guess');

  if (wrap) wrap.style.display = 'block';
  if (btn)  btn.disabled       = true;

  const tick = () => {
    if (text) text.textContent = remaining + 's';
    if (bar)  bar.style.width  = ((remaining / COOLDOWN_SECS) * 100) + '%';
    if (remaining <= 0) { clearCooldown(); return; }
    remaining--;
  };
  tick();
  cooldownInterval = setInterval(tick, 1000);
}

function clearCooldown() {
  clearInterval(cooldownInterval);
  const wrap = document.getElementById('cooldown-wrap');
  const btn  = document.getElementById('btn-guess');
  if (wrap) wrap.style.display = 'none';
  if (btn)  btn.disabled       = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Helpers
// ─────────────────────────────────────────────────────────────────────────────

function updateNetworkPill(chainId) {
  const CHAINS = {
    1:     'Ethereum',
    31337: 'Hardhat Local',
    137:   'Polygon',
    10:    'Optimism',
    42161: 'Arbitrum',
  };
  const pill = document.getElementById('net-pill');
  const name = document.getElementById('net-name');
  if (name) name.textContent = CHAINS[chainId] || `Chain ${chainId}`;
  if (pill) pill.classList.add('ok');
}

function updateWalletUI() {
  const walletTag  = activeWallet === 'kasware' ? '· KasWare'
                   : activeWallet === 'dev'     ? '· Dev Mode'
                   : '· MetaMask';

  const addrDisplay  = document.getElementById('wallet-addr-display');
  const ownerChip    = document.getElementById('owner-chip');
  const walletPill   = document.getElementById('wallet-pill');
  const connectBtns  = document.getElementById('header-connect-btns');
  const discBtn      = document.getElementById('btn-disconnect');
  const footerAddr   = document.getElementById('contract-addr-footer');

  if (addrDisplay) addrDisplay.textContent = short(currentAccount) + ' ' + walletTag;
  if (ownerChip)   ownerChip.style.display  = isOwner() ? 'inline-flex' : 'none';
  if (walletPill)  walletPill.style.display  = 'inline-flex';
  if (connectBtns) connectBtns.style.display = 'none';
  if (discBtn)     discBtn.style.display     = 'inline-flex';
  if (footerAddr)  footerAddr.textContent    = contractInfo?.address || '—';
}

function showPanels() {
  const nc = document.getElementById('not-connected');
  const pn = document.getElementById('panels');
  if (nc) nc.style.display = 'none';
  if (pn) pn.style.display = 'block';
}

function setLoading(btnId, labelId, labelText, loading) {
  const btn   = document.getElementById(btnId);
  const label = labelId ? document.getElementById(labelId) : null;
  if (btn) btn.disabled = loading;
  if (label) {
    label.innerHTML = loading
      ? '<span class="spin"></span>'
      : (labelText || '');
  }
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function short(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function formatTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function copyContractAddress() {
  const addr = contractInfo?.address;
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(() => {
    toast('Contract address copied!', 'success', 2500);
  }).catch(() => {
    toast('Copy failed — address: ' + addr, 'info');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function showHowToPlay() {
  const el = document.getElementById('htp-modal');
  if (el) el.style.display = 'flex';
}
function closeHowToPlay(e) {
  if (!e || e.target === document.getElementById('htp-modal')) {
    const el = document.getElementById('htp-modal');
    if (el) el.style.display = 'none';
  }
}

function showDevModal() {
  const el = document.getElementById('dev-modal');
  if (el) el.style.display = 'flex';
}
function hideDevModal(e) {
  if (!e || e.target === document.getElementById('dev-modal')) {
    const el = document.getElementById('dev-modal');
    if (el) el.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confetti / Win Animation
// ─────────────────────────────────────────────────────────────────────────────

function showConfetti() {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-size:80px', 'z-index:9998', 'pointer-events:none',
    'animation:wcfade 3s forwards',
  ].join(';');
  el.textContent = '🏆';

  const style = document.createElement('style');
  style.textContent = '@keyframes wcfade{0%{opacity:1;transform:scale(.8)}20%{transform:scale(1.3)}80%{opacity:1}100%{opacity:0;transform:scale(.9)}}';
  document.head.appendChild(style);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3100);
}
