// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPoolModifyLiquidityTest {
    function modifyLiquidity(
        PoolKey memory key,
        IPoolManager.ModifyLiquidityParams memory params,
        bytes memory hookData
    ) external payable returns (bytes memory);
}

contract AddLiquidity is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        address modifyLiquidityTest = 0x9A8ca723F5dcCb7926D00B71deC55c2fEa1F50f7;
        address hook = 0xF2BE644D71936bD8544f3599edd8083De6831500;
        address tokenA = 0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E;
        address tokenB = 0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1;
        
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
        
        uint256 amount = 10000 * 1e18;
        
        vm.startBroadcast(deployerPrivateKey);
        
        IERC20(token0).approve(modifyLiquidityTest, type(uint256).max);
        IERC20(token1).approve(modifyLiquidityTest, type(uint256).max);
        
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
            tickLower: -600,
            tickUpper: 600,
            liquidityDelta: int256(amount),
            salt: bytes32(0)
        });
        
        (bool success,) = modifyLiquidityTest.call(
            abi.encodeWithSignature(
                "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
                key,
                params,
                ""
            )
        );
        require(success, "modifyLiquidity failed");
        
        vm.stopBroadcast();
        
        console2.log("Liquidity added!");
    }
}
