import { BigNumber } from '../../utils/bignumber';
import {
    PoolBase,
    PoolTypes,
    SwapPairType,
    PairTypes,
    PoolPairBase,
    SwapTypes,
} from '../../types';
import { getAddress } from '@ethersproject/address';
import { bnum } from '../../bmath';
import {
    _exactTokenInForTokenOut,
    _tokenInForExactTokenOut,
    _spotPriceAfterSwapExactTokenInForTokenOut,
    _spotPriceAfterSwapTokenInForExactTokenOut,
    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut,
    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut,
    getTimeTillExpiry,
} from './elementMath';

export interface ElementPoolToken {
    address: string;
    balance: string;
    decimals: string | number;
}

export interface ElementPoolPairData extends PoolPairBase {
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
    // Element specific fields
    totalShares: BigNumber;
    expiryTime: number;
    unitSeconds: number;
    principalToken: string;
    baseToken: string;
    currentBlockTimestamp: number;
}

export class ElementPool implements PoolBase {
    poolType: PoolTypes = PoolTypes.Element;
    swapPairType: SwapPairType;
    id: string;
    address: string;
    swapFee: string;
    totalShares: string;
    tokens: ElementPoolToken[];
    tokensList: string[];
    // Element specific
    expiryTime: number;
    unitSeconds: number;
    principalToken: string;
    baseToken: string;
    currentBlockTimestamp: number;

    constructor(
        id: string,
        address: string,
        swapFee: string,
        totalShares: string,
        tokens: ElementPoolToken[],
        tokensList: string[],
        expiryTime: number,
        unitSeconds: number,
        principalToken: string,
        baseToken: string
    ) {
        this.id = id;
        this.address = address;
        this.swapFee = swapFee;
        this.totalShares = totalShares;
        this.tokens = tokens;
        this.tokensList = tokensList;
        this.expiryTime = expiryTime;
        this.unitSeconds = unitSeconds;
        this.principalToken = principalToken;
        this.baseToken = baseToken;
        this.currentBlockTimestamp = 0;
    }

    setCurrentBlockTimestamp(timestamp: number) {
        this.currentBlockTimestamp = timestamp;
    }

    setTypeForSwap(type: SwapPairType) {
        this.swapPairType = type;
    }

    parsePoolPairData(tokenIn: string, tokenOut: string): ElementPoolPairData {
        let pairType: PairTypes;
        let tI: ElementPoolToken;
        let tO: ElementPoolToken;
        let balanceIn: string;
        let balanceOut: string;
        let decimalsOut: string | number;
        let decimalsIn: string | number;
        let tokenIndexIn: number;
        let tokenIndexOut: number;

        // Check if tokenIn is the pool token itself (BPT)
        if (tokenIn == this.address) {
            pairType = PairTypes.BptToToken;
            balanceIn = this.totalShares;
            decimalsIn = '18'; // Not used but has to be defined
        } else if (tokenOut == this.address) {
            pairType = PairTypes.TokenToBpt;
            balanceOut = this.totalShares;
            decimalsOut = '18'; // Not used but has to be defined
        } else {
            pairType = PairTypes.TokenToToken;
        }

        if (pairType != PairTypes.BptToToken) {
            tokenIndexIn = this.tokens.findIndex(
                t => getAddress(t.address) === getAddress(tokenIn)
            );
            if (tokenIndexIn < 0) throw 'Pool does not contain tokenIn';
            tI = this.tokens[tokenIndexIn];
            balanceIn = tI.balance;
            decimalsIn = tI.decimals;
        }
        if (pairType != PairTypes.TokenToBpt) {
            tokenIndexOut = this.tokens.findIndex(
                t => getAddress(t.address) === getAddress(tokenOut)
            );
            if (tokenIndexOut < 0) throw 'Pool does not contain tokenOut';
            tO = this.tokens[tokenIndexOut];
            balanceOut = tO.balance;
            decimalsOut = tO.decimals;
        }

        // We already add the virtual LP shares to the right balance
        let bnumBalanceIn = bnum(balanceIn);
        let bnumBalanceOut = bnum(balanceOut);
        if (tokenIn == this.principalToken) {
            bnumBalanceIn = bnumBalanceIn.plus(bnum(this.totalShares));
        } else if (tokenOut == this.principalToken) {
            bnumBalanceOut = bnumBalanceOut.plus(bnum(this.totalShares));
        }
        const poolPairData: ElementPoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            pairType: pairType,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            principalToken: this.principalToken,
            baseToken: this.baseToken,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            balanceIn: bnumBalanceIn,
            balanceOut: bnumBalanceOut,
            swapFee: bnum(this.swapFee),
            totalShares: bnum(this.totalShares),
            expiryTime: this.expiryTime,
            unitSeconds: this.unitSeconds,
            currentBlockTimestamp: this.currentBlockTimestamp,
        };

        return poolPairData;
    }

    // Normalized liquidity is an abstract term that can be thought of the
    // inverse of the slippage. It is proportional to the token balances in the
    // pool but also depends on the shape of the invariant curve.
    // As a standard, we define normalized liquidity in tokenOut
    getNormalizedLiquidity(poolPairData: ElementPoolPairData): BigNumber {
        // This could be refined by using the inverse of the slippage, but
        // in practice this won't have a big impact in path selection for
        // multi-hops so not a big priority
        return poolPairData.balanceOut;
    }

    getLimitAmountSwap(
        poolPairData: ElementPoolPairData,
        swapType: SwapTypes
    ): BigNumber {
        const MAX_OUT_RATIO = bnum(0.3);
        if (swapType === SwapTypes.SwapExactIn) {
            // "Ai < (Bi**(1-t)+Bo**(1-t))**(1/(1-t))-Bi" must hold in order for
            // base of root to be non-negative
            let Bi = poolPairData.balanceIn.toNumber();
            let Bo = poolPairData.balanceOut.toNumber();
            let t = getTimeTillExpiry(
                this.expiryTime,
                this.currentBlockTimestamp,
                this.unitSeconds
            );
            return bnum((Bi ** (1 - t) + Bo ** (1 - t)) ** (1 / (1 - t)) - Bi);
        } else {
            return poolPairData.balanceOut.times(MAX_OUT_RATIO);
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is BPT
        if (this.address == token) {
            this.totalShares = newBalance.toString();
        } else {
            // token is underlying in the pool
            const T = this.tokens.find(t => t.address === token);
            T.balance = newBalance.toString();
        }
    }

    _exactTokenInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _exactTokenInForTokenOut(amount, poolPairData);
    }

    _exactTokenInForBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _exactBPTInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _tokenInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _tokenInForExactTokenOut(amount, poolPairData);
    }

    _tokenInForExactBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _BPTInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _spotPriceAfterSwapExactTokenInForTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapExactTokenInForBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _spotPriceAfterSwapExactBPTInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _spotPriceAfterSwapTokenInForExactTokenOut(amount, poolPairData);
    }

    _spotPriceAfterSwapTokenInForExactBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _spotPriceAfterSwapBPTInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapExactTokenInForBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _derivativeSpotPriceAfterSwapExactBPTInForTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        poolPairData.currentBlockTimestamp = this.currentBlockTimestamp;
        return _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
            amount,
            poolPairData
        );
    }

    _derivativeSpotPriceAfterSwapTokenInForExactBPTOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    _derivativeSpotPriceAfterSwapBPTInForExactTokenOut(
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ): BigNumber {
        throw 'Element pool does not support SOR add/remove liquidity';
        return bnum(-1);
    }

    // TODO - These need updated with real maths
    _evmoutGivenIn: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
    _evmexactTokenInForBPTOut: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
    _evmexactBPTInForTokenOut: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
    _evminGivenOut: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
    _evmtokenInForExactBPTOut: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
    _evmbptInForExactTokenOut: (
        poolPairData: ElementPoolPairData,
        amount: BigNumber
    ) => BigNumber;
}
