/// <reference types="./types/bunyan-debug-stream" />
import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Command, flags } from '@oclif/command';
import { ParserOutput } from '@oclif/parser/lib/parse';
import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list';
import { ChainId, Currency, CurrencyAmount, Token } from '@uniswap/sdk-core';
import { MethodParameters } from '@uniswap/v3-sdk';
import { Pool as V3Pool } from '@uniswap/v3-sdk';
import { Pool as V4Pool } from '@uniswap/v4-sdk';
import { Pair } from '@uniswap/v2-sdk';
import { Protocol } from '@uniswap/router-sdk';
import bunyan, { default as Logger } from 'bunyan';
import bunyanDebugStream from 'bunyan-debug-stream';
import _ from 'lodash';
import NodeCache from 'node-cache';

import {
  AlphaRouter,
  CachingGasStationProvider,
  CachingTokenListProvider,
  CachingTokenProviderWithFallback,
  CachingV3PoolProvider,
  CachingV4PoolProvider,
  CHAIN_IDS_LIST,
  EIP1559GasPriceProvider,
  EthEstimateGasSimulator,
  FallbackTenderlySimulator,
  GasPrice,
  ID_TO_CHAIN_ID,
  ID_TO_NETWORK_NAME,
  ID_TO_PROVIDER,
  IRouter,
  ISwapToRatio,
  ITokenProvider,
  IV3PoolProvider,
  LegacyRouter,
  MetricLogger,
  NodeJSCache,
  OnChainQuoteProvider,
  routeAmountsToString,
  RouteWithValidQuote,
  setGlobalLogger,
  setGlobalMetric,
  SimulationStatus,
  TenderlySimulator,
  TokenPropertiesProvider,
  TokenProvider,
  UniswapMulticallProvider,
  V2PoolProvider,
  V3PoolProvider,
  V3RouteWithValidQuote,
  V4PoolProvider,
  V4Route,
  V4RouteWithValidQuote,
  V3Route,
  V2Route,
  MixedRoute
} from '../src';
import { V3_CORE_FACTORY_ADDRESSES } from '../src/util/addresses';
import {
  LegacyGasPriceProvider
} from '../src/providers/legacy-gas-price-provider';
import {
  OnChainGasPriceProvider
} from '../src/providers/on-chain-gas-price-provider';
import { PortionProvider } from '../src/providers/portion-provider';
import { OnChainTokenFeeFetcher } from '../src/providers/token-fee-fetcher';

export abstract class BaseCommand extends Command {
  static flags = {
    topN: flags.integer({
      required: false,
      default: 3,
    }),
    topNTokenInOut: flags.integer({
      required: false,
      default: 2,
    }),
    topNSecondHop: flags.integer({
      required: false,
      default: 2,
    }),
    topNSecondHopForTokenAddressRaw: flags.string({
      required: false,
      default: '',
    }),
    topNWithEachBaseToken: flags.integer({
      required: false,
      default: 2,
    }),
    topNWithBaseToken: flags.integer({
      required: false,
      default: 6,
    }),
    topNWithBaseTokenInSet: flags.boolean({
      required: false,
      default: false,
    }),
    topNDirectSwaps: flags.integer({
      required: false,
      default: 2,
    }),
    maxSwapsPerPath: flags.integer({
      required: false,
      default: 3,
    }),
    minSplits: flags.integer({
      required: false,
      default: 1,
    }),
    maxSplits: flags.integer({
      required: false,
      default: 3,
    }),
    distributionPercent: flags.integer({
      required: false,
      default: 5,
    }),
    chainId: flags.integer({
      char: 'c',
      required: false,
      default: ChainId.MAINNET,
      options: CHAIN_IDS_LIST,
    }),
    tokenListURI: flags.string({
      required: false,
    }),
    router: flags.string({
      char: 's',
      required: false,
      default: 'alpha',
    }),
    debug: flags.boolean(),
    debugJSON: flags.boolean(),
  };

  private _log: Logger | null = null;
  private _router: IRouter<any> | null = null;
  private _swapToRatioRouter: ISwapToRatio<any, any> | null = null;
  private _tokenProvider: ITokenProvider | null = null;
  private _poolProvider: IV3PoolProvider | null = null;
  private _blockNumber: number | null = null;
  private _multicall2Provider: UniswapMulticallProvider | null = null;

  get logger() {
    return this._log
      ? this._log
      : bunyan.createLogger({
        name: 'Default Logger',
      });
  }

  get router() {
    if (this._router) {
      return this._router;
    } else {
      throw 'router not initialized';
    }
  }

  get swapToRatioRouter() {
    if (this._swapToRatioRouter) {
      return this._swapToRatioRouter;
    } else {
      throw 'swapToRatioRouter not initialized';
    }
  }

  get tokenProvider() {
    if (this._tokenProvider) {
      return this._tokenProvider;
    } else {
      throw 'tokenProvider not initialized';
    }
  }

  get poolProvider() {
    if (this._poolProvider) {
      return this._poolProvider;
    } else {
      throw 'poolProvider not initialized';
    }
  }

  get blockNumber() {
    if (this._blockNumber) {
      return this._blockNumber;
    } else {
      throw 'blockNumber not initialized';
    }
  }

  get multicall2Provider() {
    if (this._multicall2Provider) {
      return this._multicall2Provider;
    } else {
      throw 'multicall2 not initialized';
    }
  }

  async init() {
    const query: ParserOutput<any, any> = this.parse();
    const {
      chainId: chainIdNumb,
      router: routerStr,
      debug,
      debugJSON,
      tokenListURI,
    } = query.flags;

    // initialize logger
    const logLevel = debug || debugJSON ? bunyan.DEBUG : bunyan.INFO;
    this._log = bunyan.createLogger({
      name: 'Uniswap Smart Order Router',
      serializers: bunyan.stdSerializers,
      level: logLevel,
      streams: debugJSON
        ? undefined
        : [
          {
            level: logLevel,
            type: 'stream',
            stream: bunyanDebugStream({
              basepath: __dirname,
              forceColor: false,
              showDate: false,
              showPid: false,
              showLoggerName: false,
              showLevel: !!debug,
            }),
          },
        ],
    });

    if (debug || debugJSON) {
      setGlobalLogger(this.logger);
    }

    const chainId = ID_TO_CHAIN_ID(chainIdNumb);
    const chainProvider = ID_TO_PROVIDER(chainId);

    const metricLogger: MetricLogger = new MetricLogger({
      chainId: chainIdNumb,
      networkName: ID_TO_NETWORK_NAME(chainId),
    });
    setGlobalMetric(metricLogger);

    const provider = new JsonRpcProvider(chainProvider, chainId);
    this._blockNumber = await provider.getBlockNumber();

    const tokenCache = new NodeJSCache<Token>(
      new NodeCache({ stdTTL: 3600, useClones: false })
    );

    let tokenListProvider: CachingTokenListProvider;
    if (tokenListURI) {
      tokenListProvider = await CachingTokenListProvider.fromTokenListURI(
        chainId,
        tokenListURI,
        tokenCache
      );
    } else {
      tokenListProvider = await CachingTokenListProvider.fromTokenList(
        chainId,
        DEFAULT_TOKEN_LIST,
        tokenCache
      );
    }

    const multicall2Provider = new UniswapMulticallProvider(chainId, provider);
    this._multicall2Provider = multicall2Provider;
    this._poolProvider = new V3PoolProvider(chainId, multicall2Provider);

    // initialize tokenProvider
    const tokenProviderOnChain = new TokenProvider(chainId, multicall2Provider);
    this._tokenProvider = new CachingTokenProviderWithFallback(
      chainId,
      tokenCache,
      tokenListProvider,
      tokenProviderOnChain
    );

    if (routerStr == 'legacy') {
      this._router = new LegacyRouter({
        chainId,
        multicall2Provider,
        poolProvider: new V3PoolProvider(chainId, multicall2Provider),
        quoteProvider: new OnChainQuoteProvider(
          chainId,
          provider,
          multicall2Provider
        ),
        tokenProvider: this.tokenProvider,
      });
    } else {
      const gasPriceCache = new NodeJSCache<GasPrice>(
        new NodeCache({ stdTTL: 15, useClones: true })
      );

      const v4PoolProvider = new CachingV4PoolProvider(
        chainId,
        new V4PoolProvider(chainId, multicall2Provider),
        new NodeJSCache(new NodeCache({ stdTTL: 360, useClones: false }))
      );
      const v3PoolProvider = new CachingV3PoolProvider(
        chainId,
        new V3PoolProvider(chainId, multicall2Provider),
        new NodeJSCache(new NodeCache({ stdTTL: 360, useClones: false }))
      );
      const tokenFeeFetcher = new OnChainTokenFeeFetcher(
        chainId,
        provider
      )
      const tokenPropertiesProvider = new TokenPropertiesProvider(
        chainId,
        new NodeJSCache(new NodeCache({ stdTTL: 360, useClones: false })),
        tokenFeeFetcher
      )
      const v2PoolProvider = new V2PoolProvider(chainId, multicall2Provider, tokenPropertiesProvider);

      const portionProvider = new PortionProvider();
      const tenderlySimulator = new TenderlySimulator(
        chainId,
        'https://api.tenderly.co',
        process.env.TENDERLY_USER!,
        process.env.TENDERLY_PROJECT!,
        process.env.TENDERLY_ACCESS_KEY!,
        process.env.TENDERLY_NODE_API_KEY!,
        v2PoolProvider,
        v3PoolProvider,
        v4PoolProvider,
        provider,
        portionProvider,
        { [ChainId.ARBITRUM_ONE]: 1 },
        5000,
        100,
        [ChainId.MAINNET]
      );

      const ethEstimateGasSimulator = new EthEstimateGasSimulator(
        chainId,
        provider,
        v2PoolProvider,
        v3PoolProvider,
        v4PoolProvider,
        portionProvider
      );

      const simulator = new FallbackTenderlySimulator(
        chainId,
        provider,
        portionProvider,
        tenderlySimulator,
        ethEstimateGasSimulator
      );

      const router = new AlphaRouter({
        provider,
        chainId,
        multicall2Provider: multicall2Provider,
        gasPriceProvider: new CachingGasStationProvider(
          chainId,
          new OnChainGasPriceProvider(
            chainId,
            new EIP1559GasPriceProvider(provider),
            new LegacyGasPriceProvider(provider)
          ),
          gasPriceCache
        ),
        simulator,
      });

      this._swapToRatioRouter = router;
      this._router = router;
    }
  }

  logSwapResults(
    routeAmounts: RouteWithValidQuote[],
    quote: CurrencyAmount<Currency>,
    quoteGasAdjusted: CurrencyAmount<Currency>,
    estimatedGasUsedQuoteToken: CurrencyAmount<Currency>,
    estimatedGasUsedUSD: CurrencyAmount<Currency>,
    estimatedGasUsedGasToken: CurrencyAmount<Currency> | undefined,
    methodParameters: MethodParameters | undefined,
    blockNumber: BigNumber,
    estimatedGasUsed: BigNumber,
    gasPriceWei: BigNumber,
    simulationStatus?: SimulationStatus,
  ) {
    
    // Enhanced route details logging for all routes
    routeAmounts.forEach((routeAmount, routeIndex) => {
      this.logger.info(`\n--- Route ${routeIndex + 1} (${routeAmount.protocol}) ---`);
      this.logger.info(`  Percentage: ${routeAmount.percent.toFixed(2)}%`);
      this.logger.info(`  Amount: ${routeAmount.amount.toFixed(6)}`);
      this.logger.info(`  Quote: ${routeAmount.quote.toFixed(6)}`);
      this.logger.info(`  Gas Estimate: ${routeAmount.gasEstimate.toString()}`);
      
      const route = routeAmount.route;
      
      if (routeAmount.protocol === Protocol.V4) {
        const v4Route = route as V4Route;
        this.logger.info(`  Token Path: ${v4Route.currencyPath.map(token => token.symbol || 'Unknown').join(' → ')}`);
        this.logger.info(`  Pools (${v4Route.pools.length}):`);
        
        v4Route.pools.forEach((pool, poolIndex) => {
          this.logger.info(`    Pool ${poolIndex + 1}:`);
          const token0Address = pool.token0.isToken ? pool.token0.address : pool.token0.name;
          const token1Address = pool.token1.isToken ? pool.token1.address : pool.token1.name;
          this.logger.info(`      Token0: ${pool.token0.symbol || 'Unknown'} (${token0Address})`);
          this.logger.info(`      Token1: ${pool.token1.symbol || 'Unknown'} (${token1Address})`);
          this.logger.info(`      Fee: ${pool.fee / 10000}%`);
          this.logger.info(`      Tick Spacing: ${pool.tickSpacing}`);
          this.logger.info(`      Hooks: ${pool.hooks}`);
          if (pool.poolKey) {
            this.logger.info(`      Pool Key: ${JSON.stringify(pool.poolKey)}`);
          }
          this.logger.info(`      Liquidity: ${pool.liquidity.toString()}`);
          this.logger.info(`      Sqrt Price: ${pool.sqrtRatioX96.toString()}`);
          this.logger.info(`      Tick: ${pool.tickCurrent}`);
        });
        
        if ('initializedTicksCrossedList' in routeAmount) {
          const v4RouteWithValidQuote = routeAmount as V4RouteWithValidQuote;
          const ticksCrossed = v4RouteWithValidQuote.initializedTicksCrossedList || [];
          const sqrtPricesAfter = v4RouteWithValidQuote.sqrtPriceX96AfterList || [];
          this.logger.info(`  Initialized Ticks Crossed: [${ticksCrossed.filter(t => t !== undefined && t !== null).join(', ')}]`);
          this.logger.info(`  Sqrt Price After: [${sqrtPricesAfter.filter(p => p !== undefined && p !== null).map(p => p.toString()).join(', ')}]`);
        }
      } else if (routeAmount.protocol === Protocol.V3) {
        const v3Route = route as V3Route;
        this.logger.info(`  Token Path: ${v3Route.tokenPath.map(token => token.symbol).join(' → ')}`);
        this.logger.info(`  Pools (${v3Route.pools.length}):`);
        
        v3Route.pools.forEach((pool, poolIndex) => {
          this.logger.info(`    Pool ${poolIndex + 1}:`);
          this.logger.info(`      Token0: ${pool.token0.symbol} (${pool.token0.address})`);
          this.logger.info(`      Token1: ${pool.token1.symbol} (${pool.token1.address})`);
          this.logger.info(`      Fee: ${pool.fee / 10000}%`);
          const poolAddress = V3Pool.getAddress(pool.token0, pool.token1, pool.fee, undefined, V3_CORE_FACTORY_ADDRESSES[pool.chainId]);
          this.logger.info(`      Pool Address: ${poolAddress}`);
          this.logger.info(`      Liquidity: ${pool.liquidity.toString()}`);
          this.logger.info(`      Sqrt Price: ${pool.sqrtRatioX96.toString()}`);
          this.logger.info(`      Tick: ${pool.tickCurrent}`);
        });
        
        if ('initializedTicksCrossedList' in routeAmount) {
          const v3RouteWithValidQuote = routeAmount as V3RouteWithValidQuote;
          const ticksCrossed = v3RouteWithValidQuote.initializedTicksCrossedList || [];
          const sqrtPricesAfter = v3RouteWithValidQuote.sqrtPriceX96AfterList || [];
          this.logger.info(`  Initialized Ticks Crossed: [${ticksCrossed.filter(t => t !== undefined && t !== null).join(', ')}]`);
          this.logger.info(`  Sqrt Price After: [${sqrtPricesAfter.filter(p => p !== undefined && p !== null).map(p => p.toString()).join(', ')}]`);
        }
      } else if (routeAmount.protocol === Protocol.V2) {
        const v2Route = route as V2Route;
        this.logger.info(`  Token Path: ${v2Route.path.map(token => token.symbol).join(' → ')}`);
        this.logger.info(`  Pairs (${v2Route.pairs.length}):`);
        
        v2Route.pairs.forEach((pair, pairIndex) => {
          this.logger.info(`    Pair ${pairIndex + 1}:`);
          this.logger.info(`      Token0: ${pair.token0.symbol} (${pair.token0.address})`);
          this.logger.info(`      Token1: ${pair.token1.symbol} (${pair.token1.address})`);
          this.logger.info(`      Reserve0: ${pair.reserve0.toFixed(6)}`);
          this.logger.info(`      Reserve1: ${pair.reserve1.toFixed(6)}`);
        });
      } else if (routeAmount.protocol === Protocol.MIXED) {
        const mixedRoute = route as MixedRoute;
        this.logger.info(`  Token Path: ${mixedRoute.path.map(token => token.symbol || 'Unknown').join(' → ')}`);
        this.logger.info(`  Pools (${mixedRoute.pools.length}):`);
        
        mixedRoute.pools.forEach((pool, poolIndex) => {
          this.logger.info(`    Pool ${poolIndex + 1}:`);
          if (pool instanceof V4Pool) {
            this.logger.info(`      Type: V4`);
            const token0Address = pool.token0.isToken ? pool.token0.address : pool.token0.name;
            const token1Address = pool.token1.isToken ? pool.token1.address : pool.token1.name;
            this.logger.info(`      Token0: ${pool.token0.symbol || 'Unknown'} (${token0Address})`);
            this.logger.info(`      Token1: ${pool.token1.symbol || 'Unknown'} (${token1Address})`);
            this.logger.info(`      Fee: ${pool.fee / 10000}%`);
            this.logger.info(`      Tick Spacing: ${pool.tickSpacing}`);
            this.logger.info(`      Hooks: ${pool.hooks}`);
          } else if (pool instanceof V3Pool) {
            this.logger.info(`      Type: V3`);
            this.logger.info(`      Token0: ${pool.token0.symbol} (${pool.token0.address})`);
            this.logger.info(`      Token1: ${pool.token1.symbol} (${pool.token1.address})`);
            this.logger.info(`      Fee: ${pool.fee / 10000}%`);
          } else if (pool instanceof Pair) {
            this.logger.info(`      Type: V2`);
            this.logger.info(`      Token0: ${pool.token0.symbol} (${pool.token0.address})`);
            this.logger.info(`      Token1: ${pool.token1.symbol} (${pool.token1.address})`);
          }
        });
      }
    });

    this.logger.info(`\n=== Summary ===`);
    this.logger.info(`${routeAmountsToString(routeAmounts)}`);

    this.logger.info(`\tRaw Quote Exact In:`);
    this.logger.info(
      `\t\t${quote.toFixed(Math.min(quote.currency.decimals, 2))}`
    );
    this.logger.info(`\tGas Adjusted Quote In:`);
    this.logger.info(
      `\t\t${quoteGasAdjusted.toFixed(
        Math.min(quoteGasAdjusted.currency.decimals, 2)
      )}`
    );
    this.logger.info(``);
    this.logger.info(
      `Gas Used Quote Token: ${estimatedGasUsedQuoteToken.toFixed(
        Math.min(estimatedGasUsedQuoteToken.currency.decimals, 6)
      )}`
    );
    this.logger.info(
      `Gas Used USD: ${estimatedGasUsedUSD.toFixed(
        Math.min(estimatedGasUsedUSD.currency.decimals, 6)
      )}`
    );
    if(estimatedGasUsedGasToken) {
      this.logger.info(
        `Gas Used gas token: ${estimatedGasUsedGasToken.toFixed(
          Math.min(estimatedGasUsedGasToken.currency.decimals, 6)
        )}`
      );
    }
    this.logger.info(`Calldata: ${methodParameters?.calldata}`);
    this.logger.info(`Value: ${methodParameters?.value}`);
    this.logger.info({
      blockNumber: blockNumber.toString(),
      estimatedGasUsed: estimatedGasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      simulationStatus: simulationStatus,
    });

    // Keep the existing V3 ticks calculation
    const v3Routes: V3RouteWithValidQuote[] =
      routeAmounts.filter(route => route.protocol === Protocol.V3) as V3RouteWithValidQuote[];
    let total = BigNumber.from(0);
    for (let i = 0; i < v3Routes.length; i++) {
      const route = v3Routes[i]!;
      const tick = BigNumber.from(
        Math.max(1, _.sum(route.initializedTicksCrossedList))
      );
      total = total.add(tick);
    }
    if (v3Routes.length > 0) {
      this.logger.info(`Total V3 ticks crossed: ${total}`);
    }
  }
}
