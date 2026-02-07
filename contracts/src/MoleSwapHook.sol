// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";

/**
 * @title MoleSwap Hook v3 - Delay Pool Architecture
 * @notice Privacy-preserving DEX using TEE + stealth addresses + time-delayed releases
 */
contract MoleSwapHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    // ══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ══════════════════════════════════════════════════════════════

    uint256 public constant MIN_DELAY = 60;
    uint256 public constant MAX_DELAY = 180;

    // ══════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════

    struct Intent {
        address sender;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        bytes viewingPubKey;
        uint256 deadline;
        uint256 submittedAt;
        bool settled;
    }

    struct PendingRelease {
        address token;
        address stealthAddress;
        uint256 amount;
        uint256 releaseTime;
        bytes encryptedStealthKey;
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

    struct SwapCallbackData {
        Settlement settlement;
        Intent intent;
    }

    // ══════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════

    IPoolManager public immutable poolManager;
    address public oracle;
    address public teeSigner;
    address public owner;
    PoolKey public poolKey;
    bool public poolInitialized;

    mapping(bytes32 => Intent) public intents;
    mapping(bytes32 => PendingRelease) public releases;
    mapping(bytes32 => bool) public processedBatches;
    
    // Track swapped output amounts for releases
    mapping(bytes32 => uint256) public swappedAmounts;

    bytes32[] public pendingIntentIds;
    bytes32[] public pendingReleaseIds;

    uint256 public intentNonce;

    // ══════════════════════════════════════════════════════════════
    // EVENTS
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

    event SwapExecuted(
        bytes32 indexed intentId,
        uint256 amountIn,
        uint256 amountOut,
        bool zeroForOne
    );

    event ReleaseQueued(
        bytes32 indexed releaseId,
        bytes32 indexed intentId,
        address stealthAddress,
        uint256 amount,
        uint256 releaseTime
    );

    event ReleaseExecuted(
        bytes32 indexed releaseId,
        address indexed stealthAddress,
        address token,
        uint256 amount,
        bytes encryptedStealthKey
    );

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
    error OnlyPoolManager();
    error InvalidSignature();
    error BatchAlreadyProcessed();
    error IntentNotFound();
    error IntentAlreadySettled();
    error IntentExpired();
    error ReleaseNotReady();
    error ReleaseAlreadyExecuted();
    error InvalidReleaseTime();
    error PoolNotInitialized();
    error InsufficientOutput();

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

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    // ══════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════

    constructor(
        IPoolManager _poolManager,
        address _oracle,
        address _teeSigner
    ) {
        poolManager = _poolManager;
        oracle = _oracle;
        teeSigner = _teeSigner;
        owner = tx.origin;
    }

    // ══════════════════════════════════════════════════════════════
    // HOOK CALLBACKS (IHooks interface)
    // ══════════════════════════════════════════════════════════════

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24) external onlyPoolManager returns (bytes4) {
        poolKey = key;
        poolInitialized = true;
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata) external pure returns (bytes4, BeforeSwapDelta, uint24) {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.afterDonate.selector;
    }

    // ══════════════════════════════════════════════════════════════
    // UNLOCK CALLBACK (for PoolManager interactions)
    // ══════════════════════════════════════════════════════════════

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        
        SwapCallbackData memory callbackData = abi.decode(data, (SwapCallbackData));
        
        // Execute the swap
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: callbackData.settlement.zeroForOne,
            amountSpecified: -int256(callbackData.intent.amountIn), // Exact input (negative = exact in)
            sqrtPriceLimitX96: callbackData.settlement.zeroForOne 
                ? 4295128740  // MIN_SQRT_PRICE + 1
                : 1461446703485210103287273052203988822378723970341 // MAX_SQRT_PRICE - 1
        });
        
        BalanceDelta delta = poolManager.swap(poolKey, params, "");
        
        // Get amounts from delta
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        
        // Determine which token we're paying and which we're receiving
        Currency currencyIn = callbackData.settlement.zeroForOne ? poolKey.currency0 : poolKey.currency1;
        Currency currencyOut = callbackData.settlement.zeroForOne ? poolKey.currency1 : poolKey.currency0;
        
        int128 amountInDelta = callbackData.settlement.zeroForOne ? amount0 : amount1;
        int128 amountOutDelta = callbackData.settlement.zeroForOne ? amount1 : amount0;
        
        // Pay the input amount (positive delta means we owe)
        if (amountInDelta < 0) {
            // Transfer tokens to PoolManager and settle
            poolManager.sync(currencyIn);
            IERC20(Currency.unwrap(currencyIn)).safeTransfer(address(poolManager), uint128(-amountInDelta));
            poolManager.settle();
        }
        
        // Take the output amount (negative delta means we receive)
        if (amountOutDelta > 0) {
            uint256 amountOut = uint256(uint128(amountOutDelta));
            poolManager.take(currencyOut, address(this), amountOut);
            
            // Store for later release
            swappedAmounts[callbackData.settlement.intentId] = amountOut;
        }
        
        return abi.encode(delta);
    }

    // ══════════════════════════════════════════════════════════════
    // USER FUNCTIONS
    // ══════════════════════════════════════════════════════════════

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

    function settleAndQueue(SettlementBatch calldata batch) external onlyOracle {
        if (processedBatches[batch.batchId]) revert BatchAlreadyProcessed();
        if (!poolInitialized) revert PoolNotInitialized();

        bytes32 batchHash = _computeBatchHash(batch);
        address signer = batchHash.toEthSignedMessageHash().recover(batch.teeSignature);
        if (signer != teeSigner) revert InvalidSignature();

        processedBatches[batch.batchId] = true;

        for (uint256 i = 0; i < batch.internalMatches.length; i++) {
            _processInternalMatch(batch.internalMatches[i]);
        }

        for (uint256 i = 0; i < batch.ammSettlements.length; i++) {
            _processAmmSettlement(batch.ammSettlements[i]);
        }

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

    function executeRelease(bytes32 releaseId) external {
        PendingRelease storage release = releases[releaseId];
        
        if (release.stealthAddress == address(0)) revert IntentNotFound();
        if (release.executed) revert ReleaseAlreadyExecuted();
        if (block.timestamp < release.releaseTime) revert ReleaseNotReady();

        release.executed = true;
        _removeFromPendingReleases(releaseId);

        IERC20(release.token).safeTransfer(release.stealthAddress, release.amount);

        emit ReleaseExecuted(
            releaseId,
            release.stealthAddress,
            release.token,
            release.amount,
            release.encryptedStealthKey
        );

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

        // Transfer tokens from user to this contract
        IERC20(intent.tokenIn).safeTransferFrom(
            intent.sender,
            address(this),
            intent.amountIn
        );
        
        // Approve PoolManager to take tokens
        IERC20(intent.tokenIn).forceApprove(address(poolManager), intent.amountIn);

        // Execute swap through PoolManager unlock pattern
        SwapCallbackData memory callbackData = SwapCallbackData({
            settlement: settlement,
            intent: intent
        });
        
        poolManager.unlock(abi.encode(callbackData));

        intent.settled = true;
        _removeFromPendingIntents(settlement.intentId);
        
        emit SwapExecuted(
            settlement.intentId,
            intent.amountIn,
            swappedAmounts[settlement.intentId],
            settlement.zeroForOne
        );
    }

    function _queueRelease(PendingRelease calldata release) internal {
        if (release.releaseTime < block.timestamp + MIN_DELAY) revert InvalidReleaseTime();
        if (release.releaseTime > block.timestamp + MAX_DELAY) revert InvalidReleaseTime();

        bytes32 releaseId = keccak256(abi.encodePacked(
            release.intentId,
            release.stealthAddress,
            release.releaseTime
        ));
        
        // Use the actual swapped amount if available, otherwise use provided amount
        uint256 releaseAmount = swappedAmounts[release.intentId] > 0 
            ? swappedAmounts[release.intentId] 
            : release.amount;

        releases[releaseId] = PendingRelease({
            token: release.token,
            stealthAddress: release.stealthAddress,
            amount: releaseAmount,
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
            releaseAmount,
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
