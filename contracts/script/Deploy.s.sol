// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {MoleSwapHook} from "../src/MoleSwapHook.sol";

contract HookDeployer {
    function deploy(bytes32 salt, IPoolManager pm, address oracle, address teeSigner) external returns (address) {
        MoleSwapHook hook = new MoleSwapHook{salt: salt}(pm, oracle, teeSigner);
        return address(hook);
    }
}

contract DeployMoleSwap is Script {
    IPoolManager constant PM = IPoolManager(0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317);
    
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address oracle = vm.envOr("ORACLE_ADDRESS", deployer);
        address teeSigner = vm.envOr("TEE_SIGNER", deployer);
        
        uint160 requiredFlags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG |
            Hooks.AFTER_ADD_LIQUIDITY_FLAG |
            Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
        );
        
        console2.log("Required flags:", requiredFlags);
        
        vm.startBroadcast(pk);
        
        // Deploy factory first
        HookDeployer factory = new HookDeployer();
        console2.log("Factory:", address(factory));
        
        // Compute creation code hash for CREATE2 from factory
        bytes memory creationCode = abi.encodePacked(
            type(MoleSwapHook).creationCode,
            abi.encode(PM, oracle, teeSigner)
        );
        bytes32 initCodeHash = keccak256(creationCode);
        
        // Mine salt
        bytes32 salt;
        address predicted;
        bool found = false;
        
        for (uint256 i = 0; i < 5000000; i++) {
            salt = bytes32(i);
            predicted = address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xff),
                address(factory),
                salt,
                initCodeHash
            )))));
            
            if ((uint160(predicted) & uint160(Hooks.ALL_HOOK_MASK)) == requiredFlags) {
                found = true;
                console2.log("Found at:", i);
                break;
            }
        }
        
        require(found, "Salt not found");
        console2.log("Salt:", uint256(salt));
        console2.log("Predicted:", predicted);
        
        address hook = factory.deploy(salt, PM, oracle, teeSigner);
        console2.log("Deployed:", hook);
        require(hook == predicted, "Mismatch");
        
        vm.stopBroadcast();
    }
}
