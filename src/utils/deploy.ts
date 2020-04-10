/**
 * Command line deployment utils.
 */

import { ZWeb3, flattenSourceCode } from '@openzeppelin/upgrades';
import { publishToEtherscan } from './verifier';

// Need JS style import
// https://github.com/ethereum/web3.js/tree/1.x/packages/web3-providers-ws
// https://github.com/ethereum/web3.js/blob/1.x/packages/web3-providers-ws/src/index.js
const Web3WsProvider = require('web3-providers-ws');

// Needs JS tyle import
// https://github.com/trufflesuite/truffle/blob/develop/packages/hdwallet-provider/src/index.ts
const HDWalletProvider = require('@truffle/hdwallet-provider');

import assert = require('assert');


/**
  * Prepare a new deployment account.
  *
  * @param privateKeyHex raw private key
  */
export async function checkDeploymentAccounts(privateKeys: string[]): Promise<void> {
  const { web3 } = ZWeb3;

  for (const privateKeyHex of privateKeys) {
    //  When using web3.eth.accounts.privateKeyToAccount
    // https://web3js.readthedocs.io/en/v1.2.0/web3-eth-accounts.html#privatekeytoaccount
    const account = web3.eth.accounts.privateKeyToAccount(`0x${privateKeyHex}`);

    // Check we have gas money for the deployment
    const weiBalance = await web3.eth.getBalance(account.address);
    const ethBalance = web3.utils.fromWei(weiBalance, 'ether');

    const balance = web3.utils.toBN(weiBalance);

    // Big number dies on decimals, so feed it only integers
    if (balance.isZero()) {
      throw new Error(`Deployment account ${account.address} has no ETH. If this is a testnet account check https://goerli-faucet.slock.it/ to get some testnet ETH.`);
    }

    console.log(`Deployment account ${account.address} balance:`, ethBalance, 'ETH');
  }
}

/**
 *  Creates a Web3 provider that uses local private keys for signing the transactions
 *  and WebSockets to communicate and broadcast transactions over Infura node.
 */
export function createProvider(privateKeys: string[], infuraProjectId: string, network: string): any {
  // https://github.com/trufflesuite/truffle/tree/develop/packages/hdwallet-provider

  // Be explicit on our connection options so we
  // can better understand situations like timeouts
  // TODO: FUTURE! https://github.com/ethereum/web3.js/pull/3190
  const wsOptions = {
    timeout: 5000,
  };

  assert(infuraProjectId, 'Infure project id missing');
  const rpcURL = `wss://${network}.infura.io/ws/v3/${infuraProjectId}`;

  console.log('Connecting to Infura endpoint', rpcURL);

  const connectionProvider = new Web3WsProvider(rpcURL, wsOptions);

  const zeroExPrivateKeys = privateKeys.map((x) => `0x${x}`);

  // We need this to not to trigger server-side eth_send RPC
  // that is not supported by Infura.
  // Instead, HDWalletProvider will sign transactions locally
  // using imported private key.
  const walletProvider = new HDWalletProvider(zeroExPrivateKeys, connectionProvider);
  console.log('Loaded private keys for addresses', walletProvider.getAddresses());

  // listen for disconnects
  function handleDisconnects(e): void {
    console.log('Disconnect', e);
  }
  connectionProvider.on('error', (e) => handleDisconnects(e));
  connectionProvider.on('end', (e) => handleDisconnects(e));

  return walletProvider;
}


/**
 * Verifies a deployed contract on EtherScan
 *
 * See https://github.com/OpenZeppelin/openzeppelin-sdk/blob/62e0a9869340693dba55bc14ef72d7c120697bc3/packages/cli/src/models/network/NetworkController.ts#L491
 * for inspiration.
 *
 * @param contract A deployed web3.eth.Contract
 * @param constructorArgumentsEncoded The original ABI encoded tightly packed Solidity parameters passed to the constructor of the contract, or empty string
 * @param etherscanAPIKey Your EtherScan.io API key
 */
export async function verifyOnEtherscan(contract: any, constructorArgumentsEncoded: string, etherscanAPIKey: string): Promise<any> {
  const { contractName } = contract.schema;
  const compilerVersion = contract.schema.compiler.version;
  const sourcePath = contract.schema.ast.absolutePath;
  // const { compilerVersion, sourcePath } = this.localController.getContractSourcePath(contractName);
  const network = await ZWeb3.getNetworkName();
  const contractAddress = contract.address;
  const contractSource = await flattenSourceCode([sourcePath]);
  const metadata = JSON.parse(contract.schema.metadata);
  const optimizer = metadata.settings.optimizer.enabled;
  const optimizerRuns = metadata.settings.optimizer.runs;

  const verifierOptions = {
    contractName,
    compilerVersion,
    optimizer,
    optimizerRuns,
    contractSource,
    contractAddress,
    network,
    constructorArgumentsEncoded,
    apiKey: etherscanAPIKey,
  };

  await publishToEtherscan(verifierOptions);
}


function getConstructorABI(_Contract: any): any {
  const { abi } = _Contract.schema;
  for (const f of abi) {
    if (f.type === 'constructor') {
      return f;
    }
    console.log('No match', f);
  }
  return null;
}

/**
 * Deploy a new contract with a log of debug around what's happening.
 * @param id internally referred contract variable
 * @param _Contract From Contracts.getFromLocal()
 * @param parameters Array of arguments passed to the contract constructor
 * @param txParams Deployment transaction parameters like from and gas
 * @return Contract instance
 */
export async function deployContract(id: string, _Contract: any, parameters: string[], txParams: any, etherscanAPIKey: string = null): Promise<any> {
  // Check we have gas money for the deployment

  const { web3 } = ZWeb3;
  const { from: account } = txParams;

  const weiBalance = await web3.eth.getBalance(account);
  const ethBalance = web3.utils.fromWei(weiBalance, 'ether');
  let constructorArgumentsEncoded = '';

  console.log(`Starting to deploy contract ${id}, constructor`, parameters, 'balance left', ethBalance, 'ETH');

  // Let's do ABI encoding for EtherScan verification of constructor arguments
  if (parameters.length > 0) {
    const constructorABI = getConstructorABI(_Contract);
    if (!constructorABI) {
      throw new Error(`Could not find constructor for ${_Contract.schema.contractName}`);
    }
    const types = constructorABI.inputs;
    constructorArgumentsEncoded = web3.eth.abi.encodeParameters(types, parameters);
    console.log('Constructor arguments are', constructorABI.inputs, 'and encoded as', constructorArgumentsEncoded);
  }

  const p = _Contract.new(...parameters, txParams);
  const deployed = await p;
  // console.log(deployed);
  // https://stackoverflow.com/questions/34743960/is-there-a-way-to-round-to-2-decimals-in-a-template-string
  const gasUsed = (deployed.deployment.transactionReceipt.cumulativeGasUsed / 1000).toFixed(2);
  console.log(`Deployed ${id} at ${deployed.address} gas used ${gasUsed}k`);

  if (etherscanAPIKey) {
    verifyOnEtherscan(deployed, constructorArgumentsEncoded, etherscanAPIKey);
  }

  return _Contract.at(deployed.address);
}
