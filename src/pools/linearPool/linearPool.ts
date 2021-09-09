import { getAddress } from '@ethersproject/address';
import { bnum, scale, ZERO } from '../../utils/bignumber';
import { BigNumber } from '../../utils/bignumber';
import * as SDK from '@georgeroman/balancer-v2-pools';
import {
    PoolBase,
    PoolTypes,
    SwapPairType,
    PairTypes,
    PoolPairBase,
    SwapTypes,
    SubgraphPoolBase,
} from '../../types';
import {
    _exactTokenInForTokenOut,
    _exactTokenInForBPTOut,
    _exactBPTInForTokenOut,
    _tokenInForExactTokenOut,
    _tokenInForExactBPTOut,
    _BPTInForExactTokenOut,
    _spotPriceAfterSwapExactTokenInForTokenOut,
    _spotPriceAfterSwapExactTokenInForBPTOut,
    _spotPriceAfterSwapExactBPTInForTokenOut,
    _spotPriceAfterSwapTokenInForExactTokenOut,
    _spotPriceAfterSwapTokenInForExactBPTOut,
    _spotPriceAfterSwapBPTInForExactTokenOut,
    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut,
    _derivativeSpotPriceAfterSwapExactTokenInForBPTOut,
    _derivativeSpotPriceAfterSwapExactBPTInForTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactBPTOut,
    _derivativeSpotPriceAfterSwapBPTInForExactTokenOut,
} from './linearMath';

export interface LinearPoolToken {
    address: string;
    balance: string;
    decimals: string | number;
    priceRate?: string;
}

export interface LinearPoolPairData extends PoolPairBase {
    id: string;
    address: string;
    poolType: PoolTypes;
    pairType: PairTypes;
    tokenIn: string;
    tokenOut: string;
    balanceIn: BigNumber;
    balanceOut: BigNumber;
    swapFee: BigNumber;
    decimalsIn: number;
    decimalsOut: number;
    wrappedBalance: BigNumber;
    rate: BigNumber;
    target1: BigNumber;
    target2: BigNumber;
}

export class LinearPool implements PoolBase {
    poolType: PoolTypes = PoolTypes.Linear;
    swapPairType: SwapPairType;
    id: string;
    address: string;
    swapFee: BigNumber;
    totalShares: BigNumber;
    tokens: LinearPoolToken[];
    tokensList: string[];

    wrappedIndex: number;
    target1: BigNumber;
    target2: BigNumber;
    MAX_IN_RATIO = bnum(0.3); // ?
    MAX_OUT_RATIO = bnum(0.3); // ?

    static fromPool(pool: SubgraphPoolBase): LinearPool {
        return new LinearPool(
            pool.id,
            pool.address,
            pool.swapFee,
            pool.totalShares,
            pool.tokens,
            pool.tokensList,
            pool.wrappedIndex,
            pool.target1,
            pool.target2
        );
    }

    constructor(
        id: string,
        address: string,
        swapFee: string,
        totalShares: string,
        tokens: LinearPoolToken[],
        tokensList: string[],
        wrappedIndex: number,
        target1: string,
        target2: string
    ) {
        this.id = id;
        this.address = address;
        this.swapFee = bnum(swapFee);
        this.totalShares = bnum(totalShares);
        this.tokens = tokens;
        this.tokensList = tokensList;
        this.wrappedIndex = wrappedIndex;
        // rate is now inside wrapped token info
        this.target1 = bnum(target1);
        this.target2 = bnum(target2);
    }

    setTypeForSwap(type: SwapPairType) {
        this.swapPairType = type;
    }

    parsePoolPairData(tokenIn: string, tokenOut: string): LinearPoolPairData {
        let pairType: PairTypes;
        let tI: LinearPoolToken;
        let tO: LinearPoolToken;
        let balanceIn: BigNumber;
        let balanceOut: BigNumber;
        let decimalsOut: string | number;
        let decimalsIn: string | number;

        // Check if tokenIn is the pool token itself (BPT)
        if (tokenIn == this.address) {
            pairType = PairTypes.BptToToken;
            if (this.totalShares === undefined)
                throw 'Pool missing totalShares field';
            balanceIn = this.totalShares;
            decimalsIn = '18'; // Not used but has to be defined
        } else if (tokenOut == this.address) {
            pairType = PairTypes.TokenToBpt;
            if (this.totalShares === undefined)
                throw 'Pool missing totalShares field';
            balanceOut = this.totalShares;
            decimalsOut = '18'; // Not used but has to be defined
        } else {
            pairType = PairTypes.TokenToToken;
        }

        if (pairType != PairTypes.BptToToken) {
            let tokenIndexIn = this.tokens.findIndex(
                (t) => getAddress(t.address) === getAddress(tokenIn)
            );
            if (tokenIndexIn < 0) throw 'Pool does not contain tokenIn';
            tI = this.tokens[tokenIndexIn];
            balanceIn = bnum(tI.balance);
            decimalsIn = tI.decimals;
        }
        if (pairType != PairTypes.TokenToBpt) {
            let tokenIndexOut = this.tokens.findIndex(
                (t) => getAddress(t.address) === getAddress(tokenOut)
            );
            if (tokenIndexOut < 0) throw 'Pool does not contain tokenOut';
            tO = this.tokens[tokenIndexOut];
            balanceOut = bnum(tO.balance);
            decimalsOut = tO.decimals;
        }

        const poolPairData: LinearPoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            pairType: pairType,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            balanceIn: balanceIn,
            balanceOut: balanceOut,
            swapFee: this.swapFee,
            wrappedBalance: bnum(this.tokens[this.wrappedIndex].balance),
            rate: bnum(this.tokens[this.wrappedIndex].priceRate),
            target1: this.target1,
            target2: this.target2,
        };

        return poolPairData;
    }

    getNormalizedLiquidity(poolPairData: LinearPoolPairData) {
        return bnum(0);
    }

    getLimitAmountSwap(
        poolPairData: PoolPairBase,
        swapType: SwapTypes
    ): BigNumber {
        if (swapType === SwapTypes.SwapExactIn) {
            return poolPairData.balanceIn.times(this.MAX_IN_RATIO);
        } else {
            return poolPairData.balanceOut.times(this.MAX_OUT_RATIO);
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is BPT
        if (this.address == token) {
            this.totalShares = newBalance;
        } else {
            // token is underlying in the pool
            const T = this.tokens.find((t) => t.address === token);
            T.balance = newBalance.toString();
        }
    }

    // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
    // i.e. when using token with 2decimals 0.002 should be returned as 0
    // Uses ROUND_DOWN mode (1)
    _exactTokenInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _exactTokenInForTokenOut(amount, poolPairData).dp(
            poolPairData.decimalsOut,
            1
        );
    }

    _exactTokenInForBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _exactTokenInForBPTOut(amount, poolPairData);
    }

    _exactBPTInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _exactBPTInForTokenOut(amount, poolPairData);
    }

    // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
    // i.e. when using token with 2decimals 0.002 should be returned as 0
    // Uses ROUND_UP mode (0)
    _tokenInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _tokenInForExactTokenOut(amount, poolPairData).dp(
            poolPairData.decimalsIn,
            0
        );
    }

    _tokenInForExactBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _tokenInForExactBPTOut(amount, poolPairData);
    }

    _BPTInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _BPTInForExactTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapExactTokenInForTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapExactTokenInForBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapExactTokenInForBPTOut(amount, poolPairData);
    }

    _spotPriceAfterSwapExactBPTInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapExactBPTInForTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapTokenInForExactTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapTokenInForExactBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapTokenInForExactBPTOut(amount, poolPairData);
    }

    _spotPriceAfterSwapBPTInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _spotPriceAfterSwapBPTInForExactTokenOut(amount, poolPairData);
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapExactTokenInForBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapExactTokenInForBPTOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapExactBPTInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapExactBPTInForTokenOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapTokenInForExactBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapTokenInForExactBPTOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapBPTInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        return _derivativeSpotPriceAfterSwapBPTInForExactTokenOut(
            amount,
            poolPairData
        );
    }

    _evmoutGivenIn(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        console.log('_evmoutGivenIn at linearPool.ts');
        try {
            // poolPair balances are normalised so must be scaled before use
            const amt = SDK.WeightedMath._calcOutGivenIn(
                scale(poolPairData.balanceIn, poolPairData.decimalsIn),
                bnum(1),
                scale(poolPairData.balanceOut, poolPairData.decimalsOut),
                bnum(1),
                scale(amount, poolPairData.decimalsIn),
                scale(poolPairData.swapFee, 18)
            );
            // return normalised amount
            return scale(amt, -poolPairData.decimalsOut);
        } catch (err) {
            return ZERO;
        }
    }

    _evmexactTokenInForBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        console.log('_evmexactTokenInForBPTOut at linearPool.ts');
        try {
            // balance: BigNumber, normalizedWeight: BigNumber, amountIn: BigNumber, bptTotalSupply: BigNumber, swapFee: BigNumber
            const amt = SDK.WeightedMath._calcBptOutGivenExactTokenIn(
                scale(poolPairData.balanceIn, poolPairData.decimalsIn),
                bnum(1),
                scale(amount, poolPairData.decimalsIn),
                scale(poolPairData.balanceOut, 18), // BPT is always 18 decimals
                scale(poolPairData.swapFee, 18)
            );
            // return normalised amount
            return scale(amt, -18); // BPT is always 18 decimals
        } catch (err) {
            return ZERO;
        }
    }

    _evmexactBPTInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        console.log('_evmexactBPTInForTokenOut at linearPool.ts');
        try {
            // poolPair balances are normalised so must be scaled before use
            const amt = SDK.WeightedMath._calcTokenOutGivenExactBptIn(
                scale(poolPairData.balanceOut, poolPairData.decimalsOut),
                bnum(1),
                scale(amount, 18), // BPT is always 18 decimals
                scale(poolPairData.balanceIn, 18), // BPT is always 18 decimals
                scale(poolPairData.swapFee, 18)
            );
            // return normalised amount
            return scale(amt, -poolPairData.decimalsOut);
        } catch (err) {
            return ZERO;
        }
    }

    _evminGivenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        try {
            // poolPair balances are normalised so must be scaled before use
            const amt = SDK.WeightedMath._calcInGivenOut(
                scale(poolPairData.balanceIn, poolPairData.decimalsIn),
                bnum(1),
                scale(poolPairData.balanceOut, poolPairData.decimalsOut),
                bnum(1),
                scale(amount, poolPairData.decimalsOut),
                scale(poolPairData.swapFee, 18)
            );

            // return normalised amount
            return scale(amt, -poolPairData.decimalsIn);
        } catch (err) {
            return ZERO;
        }
    }

    _evmtokenInForExactBPTOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        try {
            // poolPair balances are normalised so must be scaled before use
            const amt = SDK.WeightedMath._calcTokenInGivenExactBptOut(
                scale(poolPairData.balanceIn, poolPairData.decimalsIn),
                bnum(1),
                scale(amount, 18),
                scale(poolPairData.balanceOut, 18), // BPT is always 18 decimals
                scale(poolPairData.swapFee, 18)
            );

            // return normalised amount
            return scale(amt, -poolPairData.decimalsIn);
        } catch (err) {
            return ZERO;
        }
    }

    _evmbptInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: BigNumber
    ): BigNumber {
        try {
            // poolPair balances are normalised so must be scaled before use
            const amt = SDK.WeightedMath._calcBptInGivenExactTokenOut(
                scale(poolPairData.balanceOut, poolPairData.decimalsOut),
                bnum(1),
                scale(amount, poolPairData.decimalsOut),
                scale(poolPairData.balanceIn, 18), // BPT is always 18 decimals
                scale(poolPairData.swapFee, 18)
            );

            // return normalised amount
            return scale(amt, -18); // BPT always 18 decimals
        } catch (err) {
            return ZERO;
        }
    }
}
