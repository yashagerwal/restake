import fs from 'fs'
import _ from 'lodash'

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Slip10RawIndex, pathToString } from "@cosmjs/crypto";

import { Wallet as EthWallet } from "@ethersproject/wallet";

import { MsgExec } from "cosmjs-types/cosmos/authz/v1beta1/tx.js";

import Network from '../utils/Network.mjs'
import Wallet from '../utils/Wallet.mjs';
import NetworkRunner from './NetworkRunner.mjs';
import Health from './Health.mjs';
import { timeStamp, executeSync, overrideNetworks } from '../utils/Helpers.mjs'
import EthSigner from '../utils/EthSigner.mjs';

export default function Autostake(mnemonic, opts) {
  opts = opts || {}

  if (!mnemonic) {
    timeStamp('Please provide a MNEMONIC environment variable')
    process.exit()
  }

  async function run(networkNames) {
    const networks = getNetworksData()
    for (const name of networkNames) {
      if (name && !networks.map(el => el.name).includes(name)) return timeStamp('Invalid network name:', name)
    }
    const calls = networks.map(data => {
      return async () => {
        if (networkNames && networkNames.length && !networkNames.includes(data.name)) return
        if (data.enabled === false) return

        const health = new Health(data.healthCheck, { dryRun: opts.dryRun })
        health.started('⚛')
        if(await runWithRetry(data, health)){
          return health.success('Finished')
        }else{
          return health.failed('Autostake failed, skipping network')
        }
      }
    })
    await executeSync(calls, 1)
  }

  async function runWithRetry(data, health, retries, limitAddresses){
    retries = retries || 0
    const maxRetries = data.autostake?.retries || 3
    try {
      const networkRunner = await getNetworkRunner(data)
      if(!networkRunner) return true

      await networkRunner.run(limitAddresses)
      if(networkRunner.didSucceed()){
        logResults(health, networkRunner)
        return true
      }else{
        health.addLogs(networkRunner.allErrors())
        logResults(health, networkRunner)
        if(networkRunner.forceFail){
          return false
        }
        limitAddresses = networkRunner.failedAddresses()
      }
    } catch (e) {
      health.log('Failed: ', e.message);
    }
    if(retries < maxRetries){
      health.log(`Failed attempt ${retries + 1}/${maxRetries}, retrying in 30 seconds...`)
      await health.sendLog()
      await new Promise(r => setTimeout(r, 30 * 1000));
      return await runWithRetry(data, health, retries + 1, limitAddresses)
    }
    return false
  }

  function logResults(health, networkRunner){
    const { network, results } = networkRunner
    const errors = results.filter(result => result.error)
    timeStamp(`${network.prettyName} summary:`);
    for (let [index, result] of results.entries()) {
      timeStamp(`TX ${index + 1}:`, result.message);
    }
    return health.log(`Sent ${results.length - errors.length}/${results.length} messages`)
  }

  async function getNetworkRunner(data) {
    const network = new Network(data)
    try {
      await network.load()
    } catch {
      throw new Error('Unable to load network data for', network.name)
    }

    timeStamp('Loaded', network.prettyName)

    const { signer, slip44 } = await getSigner(network)
    const wallet = new Wallet(network, signer)
    const botAddress = await wallet.getAddress()

    timeStamp('Bot address is', botAddress)

    if (network.slip44 && network.slip44 !== slip44) {
      timeStamp("!! You are not using the preferred derivation path !!")
      timeStamp("!! You should switch to the correct path unless you have grants. Check the README !!")
    }

    const operator = network.getOperatorByBotAddress(botAddress)
    if (!operator) return timeStamp('Not an operator')

    if (!network.authzSupport) return timeStamp('No Authz support')

    await network.connect()

    const { restUrl, usingDirectory } = network

    if (!restUrl) throw new Error('Could not connect to REST API')

    timeStamp('Using REST URL', restUrl)

    if (usingDirectory) {
      timeStamp('You are using public nodes, script may fail with many delegations. Check the README to use your own')
      timeStamp('Delaying briefly to reduce load...')
      await new Promise(r => setTimeout(r, (Math.random() * 31) * 1000));
    }

    const signingClient = wallet.signingClient()
    signingClient.registry.register("/cosmos.authz.v1beta1.MsgExec", MsgExec)

    return new NetworkRunner(
      network,
      operator,
      signingClient,
      opts
    )
  }

  async function getSigner(network) {
    let slip44
    if (network.data.autostake?.correctSlip44 || network.slip44 === 60) {
      if (network.slip44 === 60) timeStamp('Found ETH coin type')
      slip44 = network.slip44 || 118
    } else {
      slip44 = network.data.autostake?.slip44 || 118
    }
    let hdPath = [
      Slip10RawIndex.hardened(44),
      Slip10RawIndex.hardened(slip44),
      Slip10RawIndex.hardened(0),
      Slip10RawIndex.normal(0),
      Slip10RawIndex.normal(0),
    ];
    slip44 != 118 && timeStamp('Using HD Path', pathToString(hdPath))

    let signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: network.prefix,
      hdPaths: [hdPath]
    });

    if (network.slip44 === 60) {
      const ethSigner = EthWallet.fromMnemonic(mnemonic);
      signer = EthSigner(signer, ethSigner, network.prefix)
    }

    return { signer, slip44 }
  }

  function getNetworksData() {
    const networksData = fs.readFileSync('src/networks.json');
    const networks = JSON.parse(networksData);
    try {
      const overridesData = fs.readFileSync('src/networks.local.json');
      const overrides = overridesData && JSON.parse(overridesData) || {}
      return overrideNetworks(networks, overrides)
    } catch (error) {
      timeStamp('Failed to parse networks.local.json, check JSON is valid', error.message)
      return networks
    }
  }

  return {
    run
  }
}