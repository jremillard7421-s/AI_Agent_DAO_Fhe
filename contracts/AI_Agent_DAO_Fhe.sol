pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AIDaoDeFiFundFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => euint32) public encryptedProposals;
    mapping(uint256 => euint32) public encryptedVotes;
    mapping(uint256 => uint256) public proposalCountInBatch;
    mapping(uint256 => uint256) public voteCountInBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsUpdated(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ProposalSubmitted(address indexed provider, uint256 indexed batchId, uint256 indexed proposalId);
    event VoteSubmitted(address indexed provider, uint256 indexed batchId, uint256 indexed voteId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] proposalResults, uint256[] voteResults);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyProcessed();
    error InvalidCooldown();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default 1 minute cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        proposalCountInBatch[currentBatchId] = 0;
        voteCountInBatch[currentBatchId] = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatch();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitProposal(euint32 encryptedProposal) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        uint256 proposalId = proposalCountInBatch[currentBatchId] + 1;
        proposalCountInBatch[currentBatchId] = proposalId;
        encryptedProposals[proposalId] = encryptedProposal;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ProposalSubmitted(msg.sender, currentBatchId, proposalId);
    }

    function submitVote(euint32 encryptedVote) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        uint256 voteId = voteCountInBatch[currentBatchId] + 1;
        voteCountInBatch[currentBatchId] = voteId;
        encryptedVotes[voteId] = encryptedVote;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(msg.sender, currentBatchId, voteId);
    }

    function requestBatchDecryption() external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (proposalCountInBatch[currentBatchId] == 0 || voteCountInBatch[currentBatchId] == 0) {
            revert InvalidBatch();
        }

        uint256 numProposals = proposalCountInBatch[currentBatchId];
        uint256 numVotes = voteCountInBatch[currentBatchId];

        bytes32[] memory cts = new bytes32[](numProposals + numVotes);
        for (uint256 i = 0; i < numProposals; i++) {
            cts[i] = encryptedProposals[i + 1].toBytes32();
        }
        for (uint256 i = 0; i < numVotes; i++) {
            cts[numProposals + i] = encryptedVotes[i + 1].toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        uint256 batchId = decryptionContexts[requestId].batchId;
        uint256 numProposals = proposalCountInBatch[batchId];
        uint256 numVotes = voteCountInBatch[batchId];

        if (numProposals == 0 || numVotes == 0) revert InvalidBatch();

        bytes32[] memory cts = new bytes32[](numProposals + numVotes);
        for (uint256 i = 0; i < numProposals; i++) {
            cts[i] = encryptedProposals[i + 1].toBytes32();
        }
        for (uint256 i = 0; i < numVotes; i++) {
            cts[numProposals + i] = encryptedVotes[i + 1].toBytes32();
        }

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            uint256 totalValues = numProposals + numVotes;
            uint256 cleartextsLength = cleartexts.length;
            if (cleartextsLength != totalValues * 32) revert InvalidProof();

            uint256[] memory proposalResults = new uint256[](numProposals);
            uint256[] memory voteResults = new uint256[](numVotes);

            for (uint256 i = 0; i < numProposals; i++) {
                assembly {
                    mstore(add(proposalResults, mul(add(i, 1), 32)), mload(add(add(cleartexts, 0x20), mul(i, 0x20))))
                }
            }
            for (uint256 i = 0; i < numVotes; i++) {
                assembly {
                    mstore(add(voteResults, mul(add(i, 1), 32)), mload(add(add(cleartexts, 0x20), mul(add(i, numProposals), 0x20))))
                }
            }

            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, batchId, proposalResults, voteResults);
        } catch {
            revert InvalidProof();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!value.isInitialized()) {
            value.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!value.isInitialized()) {
            revert("FHE: value not initialized");
        }
    }
}