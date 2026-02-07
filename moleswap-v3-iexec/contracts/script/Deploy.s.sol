// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {MoleSwapHook} from "../src/MoleSwapHook.sol";

/// @notice Mines a salt for CREATE2 deployment with correct hook flags
library HookMiner {
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs
    ) internal pure returns (address, bytes32) {
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initCodeHash = keccak256(initCode);
        
        for (uint256 salt = 0; salt < 100000; salt++) {
            address addr = computeAddress(deployer, bytes32(salt), initCodeHash);
            if (uint160(addr) & flags == flags) {
                return (addr, bytes32(salt));
            }
        }
        revert("HookMiner: could not find salt");
    }

    function computeAddress(
        address deployer,
        bytes32 salt,
        bytes32 initCodeHash
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            deployer,
            salt,
            initCodeHash
        )))));
    }
}

/// @notice Minimal ERC20 for testing
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice CREATE2 deployer proxy
contract Create2Deployer {
    function deploy(bytes32 salt, bytes memory initCode) external returns (address deployed) {
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
            if iszero(deployed) { revert(0, 0) }
        }
    }
}

contract DeployMoleSwap is Script {
    // Arbitrum Sepolia PoolManager
    IPoolManager constant PM = IPoolManager(0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address oracle = vm.envOr("ORACLE_ADDRESS", deployer);
        address teeSigner = vm.envOr("TEE_SIGNER", deployer);

        console2.log("Deployer:", deployer);
        console2.log("Oracle:", oracle);
        console2.log("TEE Signer:", teeSigner);
        console2.log("PoolManager:", address(PM));

        vm.startBroadcast(pk);

        // Deploy CREATE2 deployer
        Create2Deployer create2Deployer = new Create2Deployer();
        console2.log("Create2Deployer:", address(create2Deployer));

        // Required hook flags: beforeSwap + afterInitialize
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        );

        // Mine salt for correct address
        bytes memory constructorArgs = abi.encode(PM, oracle, teeSigner);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(create2Deployer),
            flags,
            type(MoleSwapHook).creationCode,
            constructorArgs
        );

        console2.log("Target hook address:", hookAddr);
        console2.log("Salt:", uint256(salt));

        // Deploy hook via CREATE2
        bytes memory initCode = abi.encodePacked(
            type(MoleSwapHook).creationCode,
            constructorArgs
        );
        address deployed = create2Deployer.deploy(salt, initCode);
        
        require(deployed == hookAddr, "Address mismatch");
        console2.log("MoleSwapHook deployed:", deployed);

        vm.stopBroadcast();

        console2.log("\n=== DEPLOYMENT COMPLETE ===");
        console2.log("Hook Address:", deployed);
        console2.log("\nUpdate your .env and frontend with:");
        console2.log("HOOK_ADDRESS=", deployed);
    }
}

contract DeployTokens is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockERC20 tokenA = new MockERC20("MoleToken A", "MOLE-A");
        MockERC20 tokenB = new MockERC20("MoleToken B", "MOLE-B");

        // Mint to deployer
        tokenA.mint(deployer, 1_000_000 ether);
        tokenB.mint(deployer, 1_000_000 ether);

        vm.stopBroadcast();

        // Sort for V4
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        console2.log("\n=== TOKENS DEPLOYED ===");
        console2.log("Token0 (lower):", t0);
        console2.log("Token1 (higher):", t1);
        console2.log("MOLE-A:", address(tokenA));
        console2.log("MOLE-B:", address(tokenB));
    }
}

contract InitializePool is Script {
    IPoolManager constant PM = IPoolManager(0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address hookAddr = vm.envAddress("HOOK_ADDRESS");
        address token0 = vm.envAddress("TOKEN0");
        address token1 = vm.envAddress("TOKEN1");

        require(token0 < token1, "token0 must be < token1");

        vm.startBroadcast(pk);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hookAddr)
        });

        // 1:1 price
        uint160 sqrtPriceX96 = 79228162514264337593543950336;

        PM.initialize(key, sqrtPriceX96);

        vm.stopBroadcast();

        console2.log("\n=== POOL INITIALIZED ===");
        console2.log("Hook:", hookAddr);
        console2.log("Token0:", token0);
        console2.log("Token1:", token1);
    }
}
