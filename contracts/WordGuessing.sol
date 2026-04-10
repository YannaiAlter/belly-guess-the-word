// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  WordGuessing
 * @notice A word-guessing game deployed on IGRA Network (EVM-compatible, Kaspa L2).
 *         Players pay exactly 10 iKAS per guess; the first correct guesser wins
 *         95% of the pot. The remaining 5% goes to the owner as a fee.
 *
 * @dev    Security patterns used:
 *           - Checks-Effects-Interactions (CEI) to prevent reentrancy
 *           - Mutex (nonReentrant) as a second line of defence
 *           - State is fully zeroed before any external call
 */
contract WordGuessing {

    // ─────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────

    /// @dev 10 iKAS expressed in wei (18 decimal places, same as ETH on EVM).
    uint256 public constant GUESS_PRICE = 10 ether;

    /// @dev Minimum seconds a player must wait between guesses.
    uint256 public constant COOLDOWN = 10 seconds;

    /// @dev Maximum guesses a single address may submit per game.
    uint256 public constant MAX_GUESSES_PER_ADDRESS = 20;

    /// @dev After this period without a winner the owner may reclaim the pot.
    uint256 public constant GAME_TIMEOUT = 1 days;

    uint256 private constant WINNER_BPS = 9500; // 95 %  (basis points)
    uint256 private constant BPS_DENOM  = 10000;

    // ─────────────────────────────────────────────
    //  Persistent State
    // ─────────────────────────────────────────────

    /// @notice Contract owner (deployer). Only they may start / reset games.
    address public owner;

    /// @notice keccak256 hash of the secret word for the current game.
    bytes32 public wordHash;

    /// @notice Optional public hint shown to players.
    string public hint;

    /// @notice Accumulated iKAS from all guess fees in the current game.
    uint256 public potBalance;

    /// @notice True while the current game is accepting guesses.
    bool public isActive;

    /// @notice Address of the winning player (address(0) if no winner yet).
    address public winner;

    /// @notice Total guesses submitted across the current game.
    uint256 public guessesCount;

    /// @notice Timestamp when the current game was started.
    uint256 public gameStartedAt;

    /// @dev Per-address cooldown: maps player → timestamp of their last guess.
    mapping(address => uint256) public lastGuessTimestamp;

    /// @dev Per-address guess counter for the current game.
    mapping(address => uint256) public guessesPerAddress;

    // ─────────────────────────────────────────────
    //  Reentrancy Guard
    // ─────────────────────────────────────────────

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "WordGuessing: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    /// @notice Emitted when the owner opens a new game round.
    event GameStarted(bytes32 indexed wordHash, string hint, uint256 timestamp);

    /// @notice Emitted for every guess attempt (correct or not).
    event GuessSubmitted(
        address indexed player,
        uint256 totalGuesses,
        bool    correct,
        uint256 timestamp
    );

    /// @notice Emitted once when a winner is found and funds are distributed.
    event WinnerDeclared(
        address indexed winner,
        uint256 winnerAmount,
        uint256 feeAmount
    );

    /// @notice Emitted when the owner reclaims the pot after a timeout.
    event GameReset(address indexed owner, uint256 reclaimedAmount, uint256 timestamp);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "WordGuessing: caller is not owner");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @notice Deploys the contract. Game starts as inactive; owner must call
     *         startGame() to begin the first round.
     */
    constructor() {
        owner = msg.sender;
        isActive = false;
    }

    // ─────────────────────────────────────────────
    //  Owner: Game Management
    // ─────────────────────────────────────────────

    /**
     * @notice Opens a new game round.
     * @param  _wordHash  keccak256(abi.encodePacked(secretWord)) — computed
     *                    OFF-CHAIN by the owner; the plaintext is never sent.
     * @param  _hint      Optional public hint (may be an empty string "").
     */
    function startGame(bytes32 _wordHash, string calldata _hint)
        external
        onlyOwner
    {
        require(!isActive, "WordGuessing: a game is already active");
        require(_wordHash != bytes32(0), "WordGuessing: invalid word hash");

        wordHash        = _wordHash;
        hint            = _hint;
        potBalance      = 0;
        isActive        = true;
        winner          = address(0);
        guessesCount    = 0;
        gameStartedAt   = block.timestamp;

        emit GameStarted(_wordHash, _hint, block.timestamp);
    }

    /**
     * @notice Allows the owner to reclaim the pot and close the game after
     *         GAME_TIMEOUT has elapsed with no winner.
     */
    function resetTimedOutGame() external onlyOwner nonReentrant {
        require(isActive, "WordGuessing: no active game");
        require(
            block.timestamp >= gameStartedAt + GAME_TIMEOUT,
            "WordGuessing: game has not timed out yet"
        );

        isActive = false;

        uint256 remaining = potBalance;
        potBalance = 0;

        emit GameReset(owner, remaining, block.timestamp);

        if (remaining > 0) {
            (bool sent, ) = owner.call{value: remaining}("");
            require(sent, "WordGuessing: pot reclaim transfer failed");
        }
    }

    // ─────────────────────────────────────────────
    //  Player: Submit a Guess
    // ─────────────────────────────────────────────

    /**
     * @notice Submit a guess. Must attach exactly 10 iKAS as msg.value.
     * @param  guess  The plaintext word the player is guessing.
     */
    function submitGuess(string calldata guess)
        external
        payable
        nonReentrant
    {
        // ── Checks ──────────────────────────────────────────────────────────
        require(isActive,               "WordGuessing: game is not active");
        require(msg.value == GUESS_PRICE,
            "WordGuessing: must send exactly 10 iKAS");
        require(
            block.timestamp >= lastGuessTimestamp[msg.sender] + COOLDOWN,
            "WordGuessing: cooldown period active"
        );
        require(
            guessesPerAddress[msg.sender] < MAX_GUESSES_PER_ADDRESS,
            "WordGuessing: maximum guesses per address reached"
        );

        // ── Effects ─────────────────────────────────────────────────────────
        potBalance                        += msg.value;
        guessesCount                      += 1;
        lastGuessTimestamp[msg.sender]     = block.timestamp;
        guessesPerAddress[msg.sender]     += 1;

        bool correct = (keccak256(abi.encodePacked(guess)) == wordHash);

        emit GuessSubmitted(msg.sender, guessesCount, correct, block.timestamp);

        if (correct) {
            uint256 winnerAmount = (potBalance * WINNER_BPS) / BPS_DENOM;
            uint256 feeAmount    = potBalance - winnerAmount;

            // Zero state BEFORE transfers (CEI)
            isActive   = false;
            winner     = msg.sender;
            potBalance = 0;

            emit WinnerDeclared(msg.sender, winnerAmount, feeAmount);

            // ── Interactions ──────────────────────────────────────────────
            (bool sentWinner, ) = msg.sender.call{value: winnerAmount}("");
            require(sentWinner, "WordGuessing: winner transfer failed");

            (bool sentOwner, ) = owner.call{value: feeAmount}("");
            require(sentOwner, "WordGuessing: fee transfer failed");
        }
    }

    // ─────────────────────────────────────────────
    //  View / Helper Functions
    // ─────────────────────────────────────────────

    /**
     * @notice Returns a snapshot of the current game state.
     */
    function getGameState()
        external
        view
        returns (
            bool    _isActive,
            bytes32 _wordHash,
            string  memory _hint,
            uint256 _potBalance,
            address _winner,
            uint256 _guessesCount,
            uint256 _gameStartedAt,
            uint256 _timeRemaining
        )
    {
        uint256 elapsed = isActive && block.timestamp >= gameStartedAt
            ? block.timestamp - gameStartedAt
            : 0;
        uint256 remaining = (isActive && elapsed < GAME_TIMEOUT)
            ? GAME_TIMEOUT - elapsed
            : 0;

        return (
            isActive,
            wordHash,
            hint,
            potBalance,
            winner,
            guessesCount,
            gameStartedAt,
            remaining
        );
    }

    /// @notice Returns the current accumulated pot in wei.
    function getPot() external view returns (uint256) {
        return potBalance;
    }

    /**
     * @notice Utility to compute the hash of a word. Use only locally/off-chain.
     */
    function computeHash(string calldata word) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(word));
    }
}
