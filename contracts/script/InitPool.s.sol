// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

contract InitPool is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        address poolManager = 0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317;
        address hook = 0xF2BE644D71936bD8544f3599edd8083De6831500;
        address tokenA = 0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E; // MOLE-A
        address tokenB = 0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1; // MOLE-B
        
        // Sort tokens
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
        
        // sqrt(1) * 2^96 = price of 1:1
        uint160 sqrtPriceX96 = 79228162514264337593543950336;
        
        vm.startBroadcast(deployerPrivateKey);
        IPoolManager(poolManager).initialize(key, sqrtPriceX96);
        vm.stopBroadcast();
        
        console2.log("Pool initialized with hook:", hook);
    }
}
