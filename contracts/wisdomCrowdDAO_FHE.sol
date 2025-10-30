pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract WisdomCrowdDAOFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct Batch {
        bool isOpen;
        uint256 totalEncryptedScore;
        uint256 totalEncryptedWeight;
        uint256 numSubmissions;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event Submission(uint256 indexed batchId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 finalScore);

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

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1; // Start with batch 1
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) public onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) public onlyOwner {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() public onlyOwner whenNotPaused {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) public onlyOwner whenNotPaused {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (!batches[batchId].isOpen) revert BatchClosed();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function _openBatch(uint256 batchId) internal {
        batches[batchId] = Batch({
            isOpen: true,
            totalEncryptedScore: 0,
            totalEncryptedWeight: 0,
            numSubmissions: 0
        });
        emit BatchOpened(batchId);
    }

    function submitEncryptedJudgment(
        uint256 batchId,
        euint32 encryptedScore,
        euint32 encryptedWeight
    ) external onlyProvider whenNotPaused {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (!batches[batchId].isOpen) revert BatchClosed();
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        _initIfNeeded(encryptedScore);
        _initIfNeeded(encryptedWeight);

        // Aggregate encrypted data
        euint32 memory currentTotalScore = FHE.asEuint32(batches[batchId].totalEncryptedScore);
        euint32 memory currentTotalWeight = FHE.asEuint32(batches[batchId].totalEncryptedWeight);

        euint32 memory newTotalScore = currentTotalScore.add(encryptedScore);
        euint32 memory newTotalWeight = currentTotalWeight.add(encryptedWeight);

        batches[batchId].totalEncryptedScore = newTotalScore.toBytes32();
        batches[batchId].totalEncryptedWeight = newTotalWeight.toBytes32();
        batches[batchId].numSubmissions++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit Submission(batchId, msg.sender);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batches[batchId].isOpen) revert("Batch must be closed for decryption");

        euint32 memory finalEncryptedScore = FHE.asEuint32(batches[batchId].totalEncryptedScore);
        euint32 memory finalEncryptedWeight = FHE.asEuint32(batches[batchId].totalEncryptedWeight);

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](2);
        cts[0] = finalEncryptedScore.toBytes32();
        cts[1] = finalEncryptedWeight.toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // 5a. Replay Guard
        if (ctx.processed) revert ReplayDetected();

        // 5b. State Verification
        // Rebuild cts in the exact same order as in requestBatchDecryption
        bytes32[] memory cts = new bytes32[](2);
        cts[0] = batches[ctx.batchId].totalEncryptedScore;
        cts[1] = batches[ctx.batchId].totalEncryptedWeight;

        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != ctx.stateHash) revert StateMismatch();

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // 5d. Decode & Finalize
        // Cleartexts are expected in the same order: score, weight
        uint256 finalScore = abi.decode(cleartexts, (uint256));
        // uint256 finalWeight = abi.decode(cleartexts[34:66], (uint256)); // Example if decoding second value

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, finalScore);
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) {
            val.initialize();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}