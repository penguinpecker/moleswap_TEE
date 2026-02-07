// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title MoleSwap Hook v3 - Delay Pool Architecture
 * @notice Privacy-preserving DEX using TEE + stealth addresses + time-delayed releases
 * 
 * PRIVACY MODEL:
 * - User submits intent with viewing public key
 * - TEE matches intents, generates stealth addresses, encrypts keys
 * - TEE determines random release times (60-180s delay)
 * - Contract holds tokens during delay period
 * - Releases are executed at TEE-specified times
 * - User decrypts stealth key to access funds
 * 
 * TRUST MODEL:
 * - TEE signs all settlement batches
 * - Contract verifies TEE signature before processing
 * - Oracle is untrusted relay (cannot steal funds or see keys)
 */
contract MoleSwapHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ══════════════════════════════════════════════════════════════

    uint256 public constant MIN_DELAY = 60;   // Minimum delay before release (seconds)
    uint256 public constant MAX_DELAY = 180;  // Maximum delay before release (seconds)

    // ══════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════

    struct Intent {
        address sender;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        bytes viewingPubKey;    // User's public key for ECIES encryption
        uint256 deadline;
        uint256 submittedAt;
        bool settled;
    }

    struct PendingRelease {
        address token;
        address stealthAddress;
        uint256 amount;
        uint256 releaseTime;        // TEE-determined release time
        bytes encryptedStealthKey;  // ECIES encrypted stealth private key
        bytes32 intentId;
        bool executed;
    }

    struct InternalMatch {
        bytes32 buyIntentId;
        bytes32 sellIntentId;
        uint256 matchedAmount;
    }

    struct Settlement {
        bytes32 intentId;
        address stealthAddress;
        uint256 amountOut;
        bool zeroForOne;
    }

    struct SettlementBatch {
        InternalMatch[] internalMatches;
        Settlement[] ammSettlements;
        PendingRelease[] releases;
        bytes32 batchId;
        uint256 timestamp;
        bytes teeSignature;
    }

    // ══════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════

    address public oracle;
    address public teeSigner;
    address public owner;
    PoolKey public poolKey;
    bool public poolInitialized;

    mapping(bytes32 => Intent) public intents;
    mapping(bytes32 => PendingRelease) public releases;
    mapping(bytes32 => bool) public processedBatches;

    bytes32[] public pendingIntentIds;
    bytes32[] public pendingReleaseIds;

    uint256 public intentNonce;

    // ══════════════════════════════════════════════════════════════
    // EVENTS - Compatible with existing frontend
    // ══════════════════════════════════════════════════════════════

    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed sender,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 deadline
    );

    event IntentCancelled(bytes32 indexed intentId, address indexed sender);

    event BatchSettled(
        bytes32 indexed batchId,
        uint256 internalMatches,
        uint256 ammSwaps,
        uint256 releasesQueued
    );

    event ReleaseQueued(
        bytes32 indexed releaseId,
        bytes32 indexed intentId,
        address stealthAddress,
        uint256 amount,
        uint256 releaseTime
    );

    // This event is compatible with the existing frontend's StealthKeyPublished
    event ReleaseExecuted(
        bytes32 indexed releaseId,
        address indexed stealthAddress,
        address token,
        uint256 amount,
        bytes encryptedStealthKey
    );

    // Legacy event for frontend compatibility
    event StealthKeyPublished(
        bytes32 indexed intentId,
        address indexed user,
        address stealthAddress,
        bytes encryptedKey
    );

    // ══════════════════════════════════════════════════════════════
    // ERRORS
    // ══════════════════════════════════════════════════════════════

    error OnlyOracle();
    error OnlyOwner();
    error InvalidSignature();
    error BatchAlreadyProcessed();
    error IntentNotFound();
    error IntentAlreadySettled();
    error IntentExpired();
    error ReleaseNotReady();
    error ReleaseAlreadyExecuted();
    error InvalidReleaseTime();
    error InsufficientBalance();
    error TransferFailed();

    // ══════════════════════════════════════════════════════════════
    // MODIFIERS
    // ══════════════════════════════════════════════════════════════

    modifier onlyOracle() {
        if (msg.sender != oracle) revert OnlyOracle();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ══════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════

    constructor(
        IPoolManager _poolManager,
        address _oracle,
        address _teeSigner
    ) BaseHook(_poolManager) {
        oracle = _oracle;
        teeSigner = _teeSigner;
        owner = msg.sender;
    }

    // ══════════════════════════════════════════════════════════════
    // HOOK FLAGS
    // ══════════════════════════════════════════════════════════════

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ══════════════════════════════════════════════════════════════
    // HOOK CALLBACKS
    // ══════════════════════════════════════════════════════════════

    function afterInitialize(
        address,
        PoolKey calldata key,
        uint160,
        int24
    ) external override onlyPoolManager returns (bytes4) {
        poolKey = key;
        poolInitialized = true;
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external view override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Only allow swaps from oracle during settlement
        if (sender != oracle) {
            // Direct swaps are allowed but don't get privacy
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // ══════════════════════════════════════════════════════════════
    // USER FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Submit a swap intent with viewing public key
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param amountIn Amount of input tokens
     * @param viewingPubKey User's viewing public key for ECIES encryption (65 bytes)
     * @param deadline Intent expiration timestamp
     */
    function submitIntent(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes calldata viewingPubKey,
        uint256 deadline
    ) external returns (bytes32 intentId) {
        require(deadline > block.timestamp, "Deadline passed");
        require(amountIn > 0, "Zero amount");
        require(viewingPubKey.length == 65, "Invalid viewing key length");

        intentId = keccak256(abi.encodePacked(
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            block.timestamp,
            intentNonce++
        ));

        intents[intentId] = Intent({
            sender: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            viewingPubKey: viewingPubKey,
            deadline: deadline,
            submittedAt: block.timestamp,
            settled: false
        });

        pendingIntentIds.push(intentId);

        emit IntentSubmitted(
            intentId,
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            deadline
        );
    }

    /**
     * @notice Cancel a pending intent (only before settlement)
     */
    function cancelIntent(bytes32 intentId) external {
        Intent storage intent = intents[intentId];
        if (intent.sender != msg.sender) revert IntentNotFound();
        if (intent.settled) revert IntentAlreadySettled();

        intent.settled = true;
        _removeFromPendingIntents(intentId);

        emit IntentCancelled(intentId, msg.sender);
    }

    // ══════════════════════════════════════════════════════════════
    // ORACLE FUNCTIONS (TEE-SIGNED)
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Settle a batch of intents and queue releases
     * @param batch TEE-signed settlement batch
     */
    function settleAndQueue(SettlementBatch calldata batch) external onlyOracle {
        // Verify batch hasn't been processed
        if (processedBatches[batch.batchId]) revert BatchAlreadyProcessed();

        // Verify TEE signature
        bytes32 batchHash = _computeBatchHash(batch);
        address signer = batchHash.toEthSignedMessageHash().recover(batch.teeSignature);
        if (signer != teeSigner) revert InvalidSignature();

        processedBatches[batch.batchId] = true;

        // Process internal matches (peer-to-peer, no AMM)
        for (uint256 i = 0; i < batch.internalMatches.length; i++) {
            _processInternalMatch(batch.internalMatches[i]);
        }

        // Process AMM settlements
        for (uint256 i = 0; i < batch.ammSettlements.length; i++) {
            _processAmmSettlement(batch.ammSettlements[i]);
        }

        // Queue all releases with delay
        for (uint256 i = 0; i < batch.releases.length; i++) {
            _queueRelease(batch.releases[i]);
        }

        emit BatchSettled(
            batch.batchId,
            batch.internalMatches.length,
            batch.ammSettlements.length,
            batch.releases.length
        );
    }

    /**
     * @notice Execute a release after its time has come
     * @dev Anyone can call this - permissionless execution
     */
    function executeRelease(bytes32 releaseId) external {
        PendingRelease storage release = releases[releaseId];
        
        if (release.stealthAddress == address(0)) revert IntentNotFound();
        if (release.executed) revert ReleaseAlreadyExecuted();
        if (block.timestamp < release.releaseTime) revert ReleaseNotReady();

        release.executed = true;
        _removeFromPendingReleases(releaseId);

        // Transfer tokens to stealth address
        IERC20(release.token).safeTransfer(release.stealthAddress, release.amount);

        // Emit both events for compatibility
        emit ReleaseExecuted(
            releaseId,
            release.stealthAddress,
            release.token,
            release.amount,
            release.encryptedStealthKey
        );

        // Legacy event for frontend compatibility
        Intent storage intent = intents[release.intentId];
        emit StealthKeyPublished(
            release.intentId,
            intent.sender,
            release.stealthAddress,
            release.encryptedStealthKey
        );
    }

    // ══════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    function _processInternalMatch(InternalMatch calldata match_) internal {
        Intent storage buyIntent = intents[match_.buyIntentId];
        Intent storage sellIntent = intents[match_.sellIntentId];

        if (buyIntent.sender == address(0)) revert IntentNotFound();
        if (sellIntent.sender == address(0)) revert IntentNotFound();
        if (buyIntent.settled || sellIntent.settled) revert IntentAlreadySettled();

        // Pull tokens from both parties
        IERC20(buyIntent.tokenIn).safeTransferFrom(
            buyIntent.sender,
            address(this),
            match_.matchedAmount
        );
        IERC20(sellIntent.tokenIn).safeTransferFrom(
            sellIntent.sender,
            address(this),
            match_.matchedAmount
        );

        // Mark as settled
        buyIntent.settled = true;
        sellIntent.settled = true;
        _removeFromPendingIntents(match_.buyIntentId);
        _removeFromPendingIntents(match_.sellIntentId);
    }

    function _processAmmSettlement(Settlement calldata settlement) internal {
        Intent storage intent = intents[settlement.intentId];
        
        if (intent.sender == address(0)) revert IntentNotFound();
        if (intent.settled) revert IntentAlreadySettled();
        if (block.timestamp > intent.deadline) revert IntentExpired();

        // Pull input tokens
        IERC20(intent.tokenIn).safeTransferFrom(
            intent.sender,
            address(this),
            intent.amountIn
        );

        // Execute swap through V4 pool
        // Note: In production, this would interact with PoolManager
        // For hackathon MVP, tokens are held for release

        intent.settled = true;
        _removeFromPendingIntents(settlement.intentId);
    }

    function _queueRelease(PendingRelease calldata release) internal {
        // Validate release time is within bounds
        if (release.releaseTime < block.timestamp + MIN_DELAY) revert InvalidReleaseTime();
        if (release.releaseTime > block.timestamp + MAX_DELAY) revert InvalidReleaseTime();

        bytes32 releaseId = keccak256(abi.encodePacked(
            release.intentId,
            release.stealthAddress,
            release.releaseTime
        ));

        releases[releaseId] = PendingRelease({
            token: release.token,
            stealthAddress: release.stealthAddress,
            amount: release.amount,
            releaseTime: release.releaseTime,
            encryptedStealthKey: release.encryptedStealthKey,
            intentId: release.intentId,
            executed: false
        });

        pendingReleaseIds.push(releaseId);

        emit ReleaseQueued(
            releaseId,
            release.intentId,
            release.stealthAddress,
            release.amount,
            release.releaseTime
        );
    }

    function _computeBatchHash(SettlementBatch calldata batch) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            batch.internalMatches,
            batch.ammSettlements,
            batch.releases,
            batch.batchId,
            batch.timestamp
        ));
    }

    function _removeFromPendingIntents(bytes32 intentId) internal {
        uint256 len = pendingIntentIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (pendingIntentIds[i] == intentId) {
                pendingIntentIds[i] = pendingIntentIds[len - 1];
                pendingIntentIds.pop();
                break;
            }
        }
    }

    function _removeFromPendingReleases(bytes32 releaseId) internal {
        uint256 len = pendingReleaseIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (pendingReleaseIds[i] == releaseId) {
                pendingReleaseIds[i] = pendingReleaseIds[len - 1];
                pendingReleaseIds.pop();
                break;
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    function getIntent(bytes32 intentId) external view returns (Intent memory) {
        return intents[intentId];
    }

    function getRelease(bytes32 releaseId) external view returns (PendingRelease memory) {
        return releases[releaseId];
    }

    function getPendingIntents() external view returns (bytes32[] memory) {
        return pendingIntentIds;
    }

    function getPendingReleases() external view returns (bytes32[] memory) {
        return pendingReleaseIds;
    }

    function getReleasesReadyToExecute() external view returns (bytes32[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < pendingReleaseIds.length; i++) {
            if (block.timestamp >= releases[pendingReleaseIds[i]].releaseTime) {
                count++;
            }
        }

        bytes32[] memory ready = new bytes32[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < pendingReleaseIds.length; i++) {
            if (block.timestamp >= releases[pendingReleaseIds[i]].releaseTime) {
                ready[idx++] = pendingReleaseIds[i];
            }
        }
        return ready;
    }

    function pendingIntentCount() external view returns (uint256) {
        return pendingIntentIds.length;
    }

    function pendingReleaseCount() external view returns (uint256) {
        return pendingReleaseIds.length;
    }

    // ══════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function setTeeSigner(address _teeSigner) external onlyOwner {
        teeSigner = _teeSigner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
