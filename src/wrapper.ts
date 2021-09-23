import { BaseProvider } from '@ethersproject/providers';
import { BigNumber } from './utils/bignumber';
import { bnum, ZERO } from './bmath';
import { getCostOutputToken } from './costToken';
import { getOnChainBalances } from './multicall';
import { filterPoolsOfInterest, filterHopPools } from './pools';
import { fetchSubgraphPools } from './subgraph';
import { calculatePathLimits, smartOrderRouter } from './sorClass';
import { formatSwaps } from './helpersClass';
import {
    SwapInfo,
    DisabledOptions,
    SwapTypes,
    NewPath,
    PoolDictionary,
    SubGraphPoolsBase,
    SwapOptions,
    PoolFilter,
} from './types';
import { ZERO_ADDRESS } from './index';

export class SOR {
    MULTIADDR: { [chainId: number]: string } = {
        1: '0xeefba1e63905ef1d7acba5a8513c70307c1ce441',
        5: '0x3b2A02F22fCbc872AF77674ceD303eb269a46ce3',
        42: '0x2cc8688C5f75E365aaEEb4ea8D6a480405A48D2A',
        137: '0xa1B2b503959aedD81512C37e9dce48164ec6a94d',
        250: '0x2FbEAbe2A5A439CACac06e9C110cd2C8e997ec21',
    };

    VAULTADDR: { [chainId: number]: string } = {
        1: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        5: '0x65748E8287Ce4B9E6D83EE853431958851550311',
        42: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        137: '0x17df34c4c5ab414b4b4f2860af2303109cfd5a33',
        250: '0x8AaecB905499A8E75b820c0EAFd7d3c2620F4065',
    };

    WETHADDR: { [chainId: number]: string } = {
        1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        5: '0x9A1000D492d40bfccbc03f413A48F5B6516Ec0Fd',
        42: '0xdFCeA9088c8A88A76FF74892C1457C17dfeef9C1',
        137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
        250: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83', // For Polygon this is actually wrapped MATIC
    };

    provider: BaseProvider;
    gasPrice: BigNumber;
    maxPools: number;
    chainId: number;
    // avg Balancer swap cost. Can be updated manually if required.
    swapCost: BigNumber;
    isUsingPoolsUrl: Boolean;
    poolsUrl: string;
    subgraphPools: SubGraphPoolsBase;
    tokenCost = {};
    onChainBalanceCache: SubGraphPoolsBase = { pools: [] };
    processedDataCache = {};
    finishedFetchingOnChain: boolean = false;
    disabledOptions: DisabledOptions;

    constructor(
        provider: BaseProvider,
        gasPrice: BigNumber,
        maxPools: number,
        chainId: number,
        poolsSource: string | SubGraphPoolsBase,
        swapCost: BigNumber = new BigNumber('100000'),
        disabledOptions: DisabledOptions = {
            isOverRide: false,
            disabledTokens: [],
        }
    ) {
        this.provider = provider;
        this.gasPrice = gasPrice;
        this.maxPools = maxPools;
        this.chainId = chainId;
        this.swapCost = swapCost;
        // The pools source can be a URL (e.g. pools from Subgraph) or a data set of pools
        if (typeof poolsSource === 'string') {
            this.isUsingPoolsUrl = true;
            this.poolsUrl = poolsSource;
        } else {
            this.isUsingPoolsUrl = false;
            this.subgraphPools = poolsSource;
        }
        this.disabledOptions = disabledOptions;
    }

    /*
    Find and cache cost of token.
    If cost is passed then it manually sets the value.
    */
    async setCostOutputToken(
        tokenOut: string,
        tokenDecimals: number,
        cost: BigNumber = null
    ): Promise<BigNumber> {
        tokenOut = tokenOut.toLowerCase();

        if (cost === null) {
            // Handle ETH/WETH cost
            if (
                tokenOut === ZERO_ADDRESS ||
                tokenOut.toLowerCase() ===
                    this.WETHADDR[this.chainId].toLowerCase()
            ) {
                this.tokenCost[tokenOut.toLowerCase()] = this.gasPrice
                    .times(this.swapCost)
                    .div(bnum(10 ** 18));
                return this.tokenCost[tokenOut.toLowerCase()];
            }
            // This calculates the cost to make a swap which is used as an input to SOR to allow it to make gas efficient recommendations
            const costOutputToken = await getCostOutputToken(
                tokenOut,
                this.gasPrice,
                this.swapCost,
                this.provider,
                this.chainId
            );

            this.tokenCost[tokenOut] = costOutputToken.div(
                bnum(10 ** tokenDecimals)
            );
            return this.tokenCost[tokenOut];
        } else {
            this.tokenCost[tokenOut] = cost;
            return cost;
        }
    }

    /*
    Saves updated pools data to internal onChainBalanceCache.
    If isOnChain is true will retrieve all required onChain data. (false is advised to only be used for testing)
    If poolsData is passed as parameter - uses this as pools source.
    If poolsData was passed in to constructor - uses this as pools source.
    If pools url was passed in to constructor - uses this to fetch pools source.
    */
    async fetchPools(
        isOnChain: boolean = true,
        poolsData: SubGraphPoolsBase = { pools: [] }
    ): Promise<boolean> {
        try {
            // If poolsData has been passed to function these pools should be used
            const isExternalPoolData =
                poolsData.pools.length > 0 ? true : false;

            let subgraphPools: SubGraphPoolsBase;

            if (isExternalPoolData) {
                subgraphPools = JSON.parse(JSON.stringify(poolsData));
                // Store as latest pools data
                if (!this.isUsingPoolsUrl) this.subgraphPools = subgraphPools;
            } else {
                // Retrieve from URL if set otherwise use data passed in constructor
                if (this.isUsingPoolsUrl)
                    subgraphPools = await fetchSubgraphPools(this.poolsUrl);
                else subgraphPools = this.subgraphPools;
            }

            let previousStringify = JSON.stringify(this.onChainBalanceCache); // Used for compare

            // Get latest on-chain balances (returns data in string/normalized format)
            this.onChainBalanceCache = await this.fetchOnChainBalances(
                subgraphPools,
                isOnChain
            );

            // If new pools are different from previous then any previous processed data is out of date so clear
            if (
                previousStringify !== JSON.stringify(this.onChainBalanceCache)
            ) {
                this.processedDataCache = {};
            }

            this.finishedFetchingOnChain = true;

            return true;
        } catch (err) {
            // On error clear all caches and return false so user knows to try again.
            this.finishedFetchingOnChain = false;
            this.onChainBalanceCache = { pools: [] };
            this.processedDataCache = {};
            console.error(`Error: fetchPools(): ${err.message}`);
            return false;
        }
    }

    /*
    Uses multicall contract to fetch all onchain balances for pools.
    */
    private async fetchOnChainBalances(
        subgraphPools: SubGraphPoolsBase,
        isOnChain: boolean = true
    ): Promise<SubGraphPoolsBase> {
        if (subgraphPools.pools.length === 0) {
            console.error('ERROR: No Pools To Fetch.');
            return { pools: [] };
        }

        // Allows for testing
        if (!isOnChain) {
            console.log(
                `!!!!!!! WARNING - Not Using Real OnChain Balances !!!!!!`
            );
            return subgraphPools;
        }

        // This will return in normalized/string format
        const onChainPools: SubGraphPoolsBase = await getOnChainBalances(
            subgraphPools,
            this.MULTIADDR[this.chainId],
            this.VAULTADDR[this.chainId],
            this.provider
        );

        // Error with multicall
        if (!onChainPools) return { pools: [] };

        return onChainPools;
    }

    async getSwaps(
<<<<<<< HEAD
        TokenIn: string,
        TokenOut: string,
        SwapType: string,
        SwapAmt: BigNumber
    ): Promise<[Swap[][], BigNumber, BigNumber, BigNumber]> {
        // The Subgraph returns tokens in lower case format so we must match this
        TokenIn = TokenIn.toLowerCase();
        TokenOut = TokenOut.toLowerCase();
        let swaps, total, marketSp, totalConsideringFees;
=======
        tokenIn: string,
        tokenOut: string,
        swapType: SwapTypes,
        swapAmt: BigNumber,
        swapOptions: SwapOptions = {
            poolTypeFilter: PoolFilter.All,
            timestamp: 0,
        }
    ): Promise<SwapInfo> {
        let swapInfo: SwapInfo = {
            tokenAddresses: [],
            swaps: [],
            swapAmount: ZERO,
            tokenIn: '',
            tokenOut: '',
            returnAmount: ZERO,
            returnAmountConsideringFees: ZERO,
            marketSp: ZERO,
        };

        // The Subgraph returns tokens in lower case format so we must match this
        tokenIn = tokenIn.toLowerCase();
        tokenOut = tokenOut.toLowerCase();

        const WETH = this.WETHADDR[this.chainId].toLowerCase();
        const wrapOptions = { isEthSwap: false, wethAddress: WETH };

        if (tokenIn === ZERO_ADDRESS) {
            tokenIn = WETH;
            wrapOptions.isEthSwap = true;
        }
        if (tokenOut === ZERO_ADDRESS) {
            tokenOut = WETH;
            wrapOptions.isEthSwap = true;
        }

        if (this.finishedFetchingOnChain) {
            let pools = JSON.parse(JSON.stringify(this.onChainBalanceCache));
            if (!(swapOptions.poolTypeFilter === PoolFilter.All))
                pools.pools = pools.pools.filter(
                    p => p.poolType === swapOptions.poolTypeFilter
                );
>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4

            // All Pools with OnChain Balances is already fetched so use that
<<<<<<< HEAD
            [
                swaps,
                total,
                marketSp,
                totalConsideringFees,
            ] = await this.processSwaps(
                TokenIn,
                TokenOut,
                SwapType,
                SwapAmt,
                this.onChainCache
            );
        } else {
            // Haven't retrieved all pools/balances so we use the pools for pairs if previously fetched
            if (!this.poolsForPairsCache[this.createKey(TokenIn, TokenOut)])
                return [[[]], bnum(0), bnum(0), bnum(0)];

            [
                swaps,
                total,
                marketSp,
                totalConsideringFees,
            ] = await this.processSwaps(
                TokenIn,
                TokenOut,
                SwapType,
                SwapAmt,
                this.poolsForPairsCache[this.createKey(TokenIn, TokenOut)],
                false
            );
        }

        return [swaps, total, marketSp, totalConsideringFees];
=======
            swapInfo = await this.processSwaps(
                tokenIn,
                tokenOut,
                swapType,
                swapAmt,
                pools,
                wrapOptions,
                true,
                swapOptions.timestamp
            );
        }

        return swapInfo;
>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4
    }

    // Will process swap/pools data and return best swaps
    // useProcessCache can be false to force fresh processing of paths/prices
    async processSwaps(
<<<<<<< HEAD
        TokenIn: string,
        TokenOut: string,
        SwapType: string,
        SwapAmt: BigNumber,
        OnChainPools: Pools,
        UserProcessCache: boolean = true
    ): Promise<[Swap[][], BigNumber, BigNumber, BigNumber]> {
        if (OnChainPools.pools.length === 0)
            return [[[]], bnum(0), bnum(0), bnum(0)];

        let pools: PoolDictionary,
            paths: Path[],
            epsOfInterest: EffectivePrice[],
            marketSp: BigNumber;
=======
        tokenIn: string,
        tokenOut: string,
        swapType: SwapTypes,
        swapAmt: BigNumber,
        onChainPools: SubGraphPoolsBase,
        wrapOptions: any,
        useProcessCache: boolean = true,
        currentBlockTimestamp: number = 0
    ): Promise<SwapInfo> {
        let swapInfo: SwapInfo = {
            tokenAddresses: [],
            swaps: [],
            swapAmount: ZERO,
            tokenIn: '',
            tokenOut: '',
            returnAmount: ZERO,
            returnAmountConsideringFees: ZERO,
            marketSp: ZERO,
        };

        if (onChainPools.pools.length === 0) return swapInfo;

        let pools: PoolDictionary, paths: NewPath[], marketSp: BigNumber;

>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4
        // If token pair has been processed before that info can be reused to speed up execution
        let cache = this.processedDataCache[
            `${tokenIn}${tokenOut}${swapType}${currentBlockTimestamp}`
        ];

        // useProcessCache can be false to force fresh processing of paths/prices
        if (!useProcessCache || !cache) {
            // If not previously cached we must process all paths/prices.

            // Always use onChain info
            // Some functions alter pools list directly but we want to keep original so make a copy to work from
            let poolsList = JSON.parse(JSON.stringify(onChainPools));
            let pathData: NewPath[];
            let hopTokens: string[];
            [pools, hopTokens] = filterPoolsOfInterest(
                poolsList.pools,
                tokenIn,
                tokenOut,
                this.maxPools,
                this.disabledOptions,
                currentBlockTimestamp
            );

            [pools, pathData] = filterHopPools(
                tokenIn,
                tokenOut,
                hopTokens,
                pools
            );

            [paths] = calculatePathLimits(pathData, swapType);

            // Update cache if used
            if (useProcessCache)
                this.processedDataCache[
                    `${tokenIn}${tokenOut}${swapType}${currentBlockTimestamp}`
                ] = {
                    pools: pools,
                    paths: paths,
                    marketSp: marketSp,
                };
        } else {
            // Using pre-processed data from cache
            pools = cache.pools;
            paths = cache.paths;
            marketSp = cache.marketSp;
        }

<<<<<<< HEAD
        let costOutputToken = this.tokenCost[TokenOut.toLowerCase()];

        if (SwapType === 'swapExactOut')
            costOutputToken = this.tokenCost[TokenIn.toLowerCase()];

=======
        let costOutputToken = this.tokenCost[tokenOut];

        if (swapType === SwapTypes.SwapExactOut)
            costOutputToken = this.tokenCost[tokenIn];

        // Use previously stored value if exists else default to 0
>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4
        if (costOutputToken === undefined) {
            costOutputToken = new BigNumber(0);
        }

        // Returns list of swaps
<<<<<<< HEAD
        // swapExactIn - total = total amount swap will return of TokenOut
        // swapExactOut - total = total amount of TokenIn required for swap
        let swaps, total, totalConsideringFees;
        [
            swaps,
            total,
            totalConsideringFees,
        ] = sor.smartOrderRouterMultiHopEpsOfInterest(
=======
        // swapExactIn - total = total amount swap will return of tokenOut
        // swapExactOut - total = total amount of tokenIn required for swap
        let swaps: any, total: BigNumber, totalConsideringFees: BigNumber;
        [swaps, total, marketSp, totalConsideringFees] = smartOrderRouter(
>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4
            JSON.parse(JSON.stringify(pools)), // Need to keep original pools for cache
            paths,
            swapType,
            swapAmt,
            this.maxPools,
<<<<<<< HEAD
            costOutputToken,
            epsOfInterest
        );

        return [swaps, total, marketSp, totalConsideringFees];
    }

    /*
    This is used as a quicker alternative to fetching all pools information.
    A subset of pools for token pair is found by checking swaps for range of input amounts.
    The onchain balances for the subset of pools is retrieved and cached for future swap calculations (i.e. when amts change).
    */
    async fetchFilteredPairPools(
        TokenIn: string,
        TokenOut: string
    ): Promise<boolean> {
        TokenIn = TokenIn.toLowerCase();
        TokenOut = TokenOut.toLowerCase();

        try {
            // Get all IPFS pools (with balance)
            let allPoolsNonBig = await this.pools.getAllPublicSwapPools(
                this.poolsUrl
            );

            // Convert to BigNumber format
            let allPools = await this.pools.formatPoolsBigNumber(
                allPoolsNonBig
            );

            let decimalsIn = 0;
            let decimalsOut = 0;

            // Find token decimals for scaling
            for (let i = 0; i < allPools.pools.length; i++) {
                for (let j = 0; j < allPools.pools[i].tokens.length; j++) {
                    if (allPools.pools[i].tokens[j].address === TokenIn) {
                        decimalsIn = Number(
                            allPools.pools[i].tokens[j].decimals
                        );
                        if (decimalsIn > 0 && decimalsOut > 0) break;
                    } else if (
                        allPools.pools[i].tokens[j].address === TokenOut
                    ) {
                        decimalsOut = Number(
                            allPools.pools[i].tokens[j].decimals
                        );
                        if (decimalsIn > 0 && decimalsOut > 0) break;
                    }
                }

                if (decimalsIn > 0 && decimalsOut > 0) break;
            }

            // These can be shared for both swap Types
            let pools: PoolDictionary, pathData: Path[];
            [pools, pathData] = this.processPairPools(
                TokenIn,
                TokenOut,
                allPools
            );

            // Find paths and prices for swap types
            let pathsExactIn: Path[], epsExactIn: EffectivePrice[];
            [pathsExactIn, epsExactIn] = this.processPathsAndPrices(
                JSON.parse(JSON.stringify(pathData)),
                pools,
                'swapExactIn'
            );

            let pathsExactOut: Path[], epsExactOut: EffectivePrice[];
            [pathsExactOut, epsExactOut] = this.processPathsAndPrices(
                pathData,
                pools,
                'swapExactOut'
            );

            // Use previously stored value if exists else default to 0
            let costOutputToken = this.tokenCost[TokenOut.toLowerCase()];
            if (costOutputToken === undefined) {
                costOutputToken = new BigNumber(0);
            }

            let allSwaps = [];

            let range = [
                bnum('0.01'),
                bnum('0.1'),
                bnum('1'),
                bnum('10'),
                bnum('100'),
                bnum('1000'),
            ];

            // Calculate swaps for swapExactIn/Out over range and save swaps (with pools) returned
            range.forEach(amt => {
                let amtIn = scale(amt, decimalsIn);
                let amtOut = amtIn;
                if (decimalsIn !== decimalsOut)
                    amtOut = scale(amt, decimalsOut);

                let swaps, total;
                [swaps, total] = sor.smartOrderRouterMultiHopEpsOfInterest(
                    JSON.parse(JSON.stringify(pools)), // Need to keep original pools
                    pathsExactIn,
                    'swapExactIn',
                    amtIn,
                    this.maxPools,
                    costOutputToken,
                    epsExactIn
                );

                allSwaps.push(swaps);
                [swaps, total] = sor.smartOrderRouterMultiHopEpsOfInterest(
                    JSON.parse(JSON.stringify(pools)), // Need to keep original pools
                    pathsExactOut,
                    'swapExactOut',
                    amtOut,
                    this.maxPools,
                    costOutputToken,
                    epsExactOut
                );

                allSwaps.push(swaps);
            });

            // List of unique pool addresses
            let filteredPools: string[] = [];
            // get unique swap pools
            allSwaps.forEach(swap => {
                swap.forEach(seq => {
                    seq.forEach(p => {
                        if (!filteredPools.includes(p.pool))
                            filteredPools.push(p.pool);
                    });
                });
            });

            // Get list of pool infos for pools of interest
            let poolsOfInterest: SubGraphPool[] = [];
            for (let i = 0; i < allPoolsNonBig.pools.length; i++) {
                let index = filteredPools.indexOf(allPoolsNonBig.pools[i].id);
                if (index > -1) {
                    filteredPools.splice(index, 1);
                    poolsOfInterest.push(allPoolsNonBig.pools[i]);
                    if (filteredPools.length === 0) break;
                }
            }

            let onChainPools: Pools = { pools: [] };
            if (poolsOfInterest.length !== 0) {
                // Retrieves onchain balances for pools list
                onChainPools = await sor.getAllPoolDataOnChain(
                    { pools: poolsOfInterest },
                    this.MULTIADDR[this.chainId],
                    this.provider
                );
            }

            // Add to cache for future use
            this.poolsForPairsCache[
                this.createKey(TokenIn, TokenOut)
            ] = onChainPools;

            return true;
        } catch (err) {
            console.error(`Error: fetchFilteredPairPools(): ${err.message}`);
            // Add to cache for future use
            this.poolsForPairsCache[this.createKey(TokenIn, TokenOut)] = {
                pools: [],
            };
            return false;
        }
    }

    // Finds pools and paths for token pairs. Independent of swap type.
    processPairPools(
        TokenIn: string,
        TokenOut: string,
        poolsList
    ): [PoolDictionary, Path[]] {
        // Retrieves intermediate pools along with tokens that are contained in these.
        let directPools: PoolDictionary,
            hopTokens: string[],
            poolsTokenIn: PoolDictionary,
            poolsTokenOut: PoolDictionary;
        [directPools, hopTokens, poolsTokenIn, poolsTokenOut] = sor.filterPools(
            poolsList.pools,
            TokenIn,
            TokenOut,
            this.maxPools
=======
            costOutputToken
>>>>>>> 6140293c6a6aa803d2aa8dac60e25d8edf47a0e4
        );

        if (useProcessCache)
            this.processedDataCache[
                `${tokenIn}${tokenOut}${swapType}${currentBlockTimestamp}`
            ].marketSp = marketSp;

        swapInfo = formatSwaps(
            swaps,
            swapType,
            swapAmt,
            tokenIn,
            tokenOut,
            total,
            totalConsideringFees,
            marketSp,
            wrapOptions
        );

        if (wrapOptions.isEthSwap) {
            if (swapInfo.tokenIn === wrapOptions.wethAddress)
                swapInfo.tokenIn = ZERO_ADDRESS;
            if (swapInfo.tokenOut === wrapOptions.wethAddress)
                swapInfo.tokenOut = ZERO_ADDRESS;
        }

        return swapInfo;
    }
}
