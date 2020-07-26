let global: any = typeof window !== 'undefined' ? window : self;
global.config = {
	apiUrl: [
		"https://01-cache.testnet.myqwertycoin.com/"
	],
	nodeList: [
		"https://testnet.myqwertycoin.com/sslnode/",
		"https://testnet.myqwertycoin.com/api/?mode=get&url=http://node-00.testnet.qwertycoin.org:8197/",
		"https://testnet.myqwertycoin.com/api/?mode=get&url=http://node-01.testnet.qwertycoin.org:8197/"
	],
	electionApiUrl: "https://voting.qwertycoin.org/api",
	websiteApiUrl: "https://www.qwertycoin.org/wp-json",
	mainnetexplorer.testnetUrl: "https://explorer.testnet.qwertycoin.org/",
	mainnetexplorer.testnetUrlHash: "https://explorer.testnet.qwertycoin.org/?hash={ID}#blockchain_transaction",
	mainnetexplorer.testnetUrlBlock: "https://explorer.testnet.qwertycoin.org/?hash={ID}#blockchain_block",
	testnetexplorer.testnetUrl: "https://explorer.testnet.qwertycoin.org/",
	testnetexplorer.testnetUrlHash: "https://explorer.testnet.qwertycoin.org/?hash={ID}#blockchain_transaction",
	testnetexplorer.testnetUrlBlock: "https://explorer.testnet.qwertycoin.org/?hash={ID}#blockchain_block",
	testnet: false,
	coinUnitPlaces: 8,
	coinDisplayUnitPlaces: 2,
	txMinConfirms: 10,
	txCoinbaseMinConfirms: 10,
	addressPrefix: 0x14820c,
	integratedAddressPrefix: 0x148201,
	addressPrefixTestnet: 0x14820c,
	integratedAddressPrefixTestnet: 0x148201,
	subAddressPrefix: 0x148202,
	subAddressPrefixTestnet: 0x148202,
	coinFee: new JSBigInt('100000000'),
	feePerKB: new JSBigInt('100000000'),
	dustThreshold: new JSBigInt('100000'), //used for choosing outputs/change - we decompose all the way down if the receiver wants now regardless of threshold
	defaultMixin: 0, // default value mixin

	idleTimeout: 30,
	idleWarningDuration: 20,

	coinSymbol: 'QWC',
	openAliasPrefix: "qwc",
	coinName: 'Qwertycoin',
	coinUriPrefix: 'qwertycoin:',
	avgBlockTime: 120,
	maxBlockNumber: 500000000,
};