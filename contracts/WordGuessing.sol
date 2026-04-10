// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract WordGuessing {
    uint256 private constant BPS_DENOM = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // hard cap: 10%
    uint256 public constant MIN_DURATION = 1 minutes;

    address public owner;
    uint256 public entryFeeWei;
    uint256 public roundDuration;
    uint16 public feeBps;
    bool public isRoundActive;

    uint256 public roundId;
    uint256 public roundStartedAt;
    uint256 public roundEndsAt;
    uint256 public potBalance;
    address public winner;
    uint256 public winnerTicket;
    uint256 public winnerIndex;
    uint256 public participantCount;
    bool public finalized;
    uint256 public finalizedAt;

    address[] private _participants;

    mapping(uint256 => mapping(address => bool)) public joinedInRound;
    mapping(uint256 => mapping(address => uint256)) public ticketNumberByPlayer;

    bool private _locked;

    event RoundStarted(
        uint256 indexed roundId,
        uint256 startedAt,
        uint256 endsAt,
        uint256 entryFeeWei,
        uint256 roundDuration
    );
    event ParticipantJoined(
        uint256 indexed roundId,
        address indexed player,
        uint256 ticketNumber,
        uint256 participantIndex,
        uint256 potBalance
    );
    event RoundFinalized(
        uint256 indexed roundId,
        address indexed winner,
        uint256 winnerTicket,
        uint256 winnerIndex,
        uint256 winnerAmount,
        uint256 feeAmount
    );
    event EntryFeeUpdated(uint256 oldFee, uint256 newFee);
    event RoundDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "Jackpot: caller is not owner");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "Jackpot: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        owner = msg.sender;
        entryFeeWei = 10 ether;
        roundDuration = 2 hours;
        feeBps = 500; // 5%
    }

    function startNewRound() external onlyOwner {
        require(!isRoundActive, "Jackpot: round already active");

        roundId += 1;
        roundStartedAt = block.timestamp;
        roundEndsAt = block.timestamp + roundDuration;
        potBalance = 0;
        winner = address(0);
        winnerTicket = 0;
        winnerIndex = 0;
        participantCount = 0;
        finalized = false;
        finalizedAt = 0;
        isRoundActive = true;

        delete _participants;

        emit RoundStarted(
            roundId,
            roundStartedAt,
            roundEndsAt,
            entryFeeWei,
            roundDuration
        );
    }

    function joinJackpot() external payable nonReentrant {
        require(isRoundActive, "Jackpot: no active round");
        require(block.timestamp < roundEndsAt, "Jackpot: round already ended");
        require(msg.value == entryFeeWei, "Jackpot: incorrect entry fee");
        require(!joinedInRound[roundId][msg.sender], "Jackpot: already joined this round");

        joinedInRound[roundId][msg.sender] = true;
        _participants.push(msg.sender);
        participantCount = _participants.length;
        potBalance += msg.value;

        uint256 ticket = uint256(
            keccak256(
                abi.encodePacked(
                    roundId,
                    msg.sender,
                    participantCount,
                    block.prevrandao,
                    block.timestamp
                )
            )
        );
        ticketNumberByPlayer[roundId][msg.sender] = ticket;

        emit ParticipantJoined(roundId, msg.sender, ticket, participantCount - 1, potBalance);
    }

    function finalizeJackpot() external nonReentrant {
        require(isRoundActive, "Jackpot: no active round");
        require(block.timestamp >= roundEndsAt, "Jackpot: round not ended");
        require(participantCount > 0, "Jackpot: no participants");
        require(!finalized, "Jackpot: already finalized");

        uint256 entropy = _computeEntropy();
        uint256 selectedIndex = entropy % participantCount;
        address selectedWinner = _participants[selectedIndex];
        uint256 selectedTicket = ticketNumberByPlayer[roundId][selectedWinner];

        uint256 feeAmount = (potBalance * feeBps) / BPS_DENOM;
        uint256 winnerAmount = potBalance - feeAmount;

        finalized = true;
        finalizedAt = block.timestamp;
        isRoundActive = false;
        winner = selectedWinner;
        winnerTicket = selectedTicket;
        winnerIndex = selectedIndex;
        potBalance = 0;

        emit RoundFinalized(
            roundId,
            selectedWinner,
            selectedTicket,
            selectedIndex,
            winnerAmount,
            feeAmount
        );

        (bool sentWinner, ) = selectedWinner.call{value: winnerAmount}("");
        require(sentWinner, "Jackpot: winner transfer failed");

        if (feeAmount > 0) {
            (bool sentOwner, ) = owner.call{value: feeAmount}("");
            require(sentOwner, "Jackpot: owner fee transfer failed");
        }
    }

    function setEntryFee(uint256 newEntryFeeWei) external onlyOwner {
        require(!isRoundActive, "Jackpot: cannot update during active round");
        require(newEntryFeeWei > 0, "Jackpot: invalid entry fee");
        uint256 old = entryFeeWei;
        entryFeeWei = newEntryFeeWei;
        emit EntryFeeUpdated(old, newEntryFeeWei);
    }

    function setRoundDuration(uint256 newRoundDuration) external onlyOwner {
        require(!isRoundActive, "Jackpot: cannot update during active round");
        require(newRoundDuration >= MIN_DURATION, "Jackpot: duration too short");
        uint256 old = roundDuration;
        roundDuration = newRoundDuration;
        emit RoundDurationUpdated(old, newRoundDuration);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        require(!isRoundActive, "Jackpot: cannot update during active round");
        require(newFeeBps <= MAX_FEE_BPS, "Jackpot: fee exceeds max cap");
        uint16 old = feeBps;
        feeBps = newFeeBps;
        emit FeeBpsUpdated(old, newFeeBps);
    }

    // Funds can only enter through joinJackpot().
    receive() external payable {
        revert("Jackpot: direct payments disabled");
    }

    fallback() external payable {
        revert("Jackpot: invalid call");
    }

    function getRoundState()
        external
        view
        returns (
            uint256 _roundId,
            bool _isRoundActive,
            uint256 _roundEndsAt,
            uint256 _entryFeeWei,
            uint256 _roundDuration,
            uint16 _feeBps,
            uint256 _potBalance,
            uint256 _participantCount,
            address _winner,
            uint256 _winnerTicket,
            bool _finalized,
            uint256 _timeRemaining
        )
    {
        return (
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
            timeRemaining()
        );
    }

    function getParticipantsCount() external view returns (uint256) {
        return participantCount;
    }

    function getParticipantAt(uint256 index) external view returns (address) {
        require(index < participantCount, "Jackpot: index out of bounds");
        return _participants[index];
    }

    function getMyTicket(uint256 queryRoundId, address player) external view returns (uint256) {
        return ticketNumberByPlayer[queryRoundId][player];
    }

    function timeRemaining() public view returns (uint256) {
        if (!isRoundActive || block.timestamp >= roundEndsAt) {
            return 0;
        }
        return roundEndsAt - block.timestamp;
    }

    function _computeEntropy() private view returns (uint256) {
        return uint256(
            keccak256(
                abi.encodePacked(
                    roundId,
                    block.prevrandao,
                    block.timestamp,
                    block.number,
                    participantCount,
                    potBalance
                )
            )
        );
    }
}
