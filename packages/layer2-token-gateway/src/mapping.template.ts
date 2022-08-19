import { GatewaySet as GatewaySetEvent, TxToL1 } from "../generated/L2GatewayRouter/L2GatewayRouter";
import { L2ToL1Transaction as ClassicL2ToL1TransactionEvent } from "../generated/ClassicArbSys/ClassicArbSys";
import { L2ToL1Tx as NitroL2ToL1TxEvent } from "../generated/NitroArbSys/NitroArbSys";
import { TicketCreated as NitroTicketCreatedEvent } from "../generated/NitroArbRetryableTx/NitroArbRetryableTx";
import { L2ArbitrumGateway } from "../generated/templates"
import { 
  WithdrawalInitiated as WithdrawalInitiatedEvent,
  DepositFinalized as DepositFinalizedEvent,
} from "../generated/templates/L2ArbitrumGateway/L2ArbitrumGateway"
import { Gateway, L2ToL1Transaction, Token, TokenGatewayJoinTable, GatewayWithdrawalData, L1ToL2Transaction, GatewayDepositData } from "../generated/schema";
import { Address, BigInt, ethereum, Bytes, log } from "@graphprotocol/graph-ts";

export const DISABLED_GATEWAY_ADDR = Address.fromString("0x0000000000000000000000000000000000000001");
const bigIntToId = (input: BigInt): string => input.toHexString()

export const addressToId = (input: Address): string =>
  input.toHexString().toLowerCase();

export const getJoinId = (gatewayId: string, tokenId: string): string =>
  gatewayId.concat(tokenId)


const createTokenGatewayPair = (l2Gateway: Address, l1Token: Address, block: ethereum.Block): void => {
  const gatewayId = addressToId(l2Gateway);
  const tokenId = addressToId(l1Token);
  const joinId = getJoinId(gatewayId, tokenId)

  // TODO: should we always create instead of load? should be faster.
  // the issue here is if creating again on subsequent deposits. would that break FKs? 
  let gatewayEntity = Gateway.load(gatewayId);
  // we use moustache to template this value in (as used in the subgraph manifest template)
  const isL2StdGateway = l2Gateway.toString().toLowerCase() == "{{{ l2StandardGateway }}}".toLowerCase()
  if(!isL2StdGateway && gatewayEntity == null) {
    gatewayEntity = new Gateway(gatewayId);
    gatewayEntity.save();
    // we want to track every new arbitrum gateway
    // so we initialize a Data Source Template
    L2ArbitrumGateway.create(l2Gateway)
  }

  let tokenEntity = Token.load(tokenId);
  if(tokenEntity == null) {
    tokenEntity = new Token(tokenId);
    tokenEntity.save();
  }

  let joinEntity = new TokenGatewayJoinTable(joinId);
  joinEntity.gateway = gatewayId;
  joinEntity.token = tokenId;
  joinEntity.l2BlockNum = block.number
  joinEntity.save();
}

export function handleGatewaySet(event: GatewaySetEvent): void {
  // this event is not triggered for the default standard gateway, so we instead declare that bridge on the subgraph manifest separately

  if (event.params.gateway == Address.zero()) {
    // TODO: handle gateways being deleted
    return;
  }
  createTokenGatewayPair(event.params.gateway, event.params.l1Token, event.block)
  
}

export function handleWithdrawal(event: WithdrawalInitiatedEvent): void {
  // this event got emitted in the gateway itself
  const gatewayAddr = event.address;

  const gatewayId = addressToId(gatewayAddr);
  const tokenId = addressToId(event.params.l1Token);
  const joinId = getJoinId(gatewayId, tokenId)

  let joinEntity = TokenGatewayJoinTable.load(joinId);
  if(joinEntity == null) {
    // the first deposit to an unrecognised pair is equivalent to a `GatewaySet` to handle the default gateway
    // if there is no gateway registered yet, then this was std bridged token since GatewaySet wasn't emitted first
    joinEntity = new TokenGatewayJoinTable(joinId);
    createTokenGatewayPair(gatewayAddr, event.params.l1Token, event.block)
  }

  const withdrawalId = bigIntToId(event.params._l2ToL1Id)
  const withdrawal = new GatewayWithdrawalData(withdrawalId)

  withdrawal.from = event.params._from
  withdrawal.to = event.params._to
  withdrawal.amount = event.params._amount
  withdrawal.exitNum = event.params._exitNum
  // disabled for consistency with deposit
  // withdrawal.l2ToL1Event = withdrawalId
  withdrawal.tokenGatewayJoin = joinId

  withdrawal.save()
}

export function handleDeposit(event: DepositFinalizedEvent): void {
  // this event got emitted in the gateway itself
  const gatewayAddr = event.address;

  const gatewayId = addressToId(gatewayAddr);
  const tokenId = addressToId(event.params.l1Token);
  const joinId = getJoinId(gatewayId, tokenId)

  let joinEntity = TokenGatewayJoinTable.load(joinId);
  if(joinEntity == null) {
    // the first deposit to an unrecognised pair is equivalent to a `GatewaySet` to handle the default gateway
    // if there is no gateway registered yet, then this was std bridged token since GatewaySet wasn't emitted first
    joinEntity = new TokenGatewayJoinTable(joinId);
    createTokenGatewayPair(gatewayAddr, event.params.l1Token, event.block)
  }
  
  // tx hash here follows 
  const depositId = event.transaction.hash.toHexString()
  let deposit = GatewayDepositData.load(depositId)
  if(deposit == null) {
    deposit = new GatewayDepositData(depositId)
    deposit.from = event.params._from
    deposit.to = event.params._to
    deposit.amount = event.params._amount
    deposit.l2BlockNum = event.block.number
    deposit.l2TxHash = event.transaction.hash
  
    deposit.tokenGatewayJoin = joinId
    // TODO: can we correlate this without parsing all blocks
    // this is determined based on the retry attempt number and some other fields
    // deposit.l1ToL2Transaction = null
    deposit.save()
  } else {
    log.error("deposit event not expected to be emitted twice in tx: {}", [depositId.toString()])
  }
}

const isNitro = (block: ethereum.Block): boolean => {
  // we use moustache to template this value in (as used in the subgraph manifest template)
  // const nitroStartBlock = BigInt.fromString("{{{ nitroGenesisBlockNum }}}")
  // return block.stateRoot.notEqual(Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")) || block.number.ge(nitroStartBlock)

  // would be better to check the mix digest or extra data, but they arent exposed in the subgraph
  return block.stateRoot.notEqual(Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000"))
}

export function handleTicketCreated(event: NitroTicketCreatedEvent): void {
  if(isNitro(event.block)) handleNitroTicketCreated(event)
  else handleClassicTicketCreated(event)
}


export class SubmitRetryableInputFields {
  public ethDepositAmount: BigInt;
  public l2Callvalue: BigInt;
  public l2Calldata: Bytes;
  public to: Address;

  constructor(tx: ethereum.Transaction) {
    // parsing fields from
//   function submitRetryable(
//     bytes32 requestId,
//     uint256 l1BaseFee,
//     uint256 deposit,
//     uint256 callvalue,
//     uint256 gasFeeCap,
//     uint64 gasLimit,
//     uint256 maxSubmissionFee,
//     address feeRefundAddress,
//     address beneficiary,
//     address retryTo,
//     bytes calldata retryData
// ) external;

    // TODO: check correct function signature
  const inputWithoutSelector = Bytes.fromUint8Array(tx.input.slice(4))
  const parsedWithoutData = ethereum.decode(
    "(bytes32,uint256,uint256,uint256,uint256,uint64,uint256,address,address,address,uint256,uint256)",
    inputWithoutSelector
  );
  if (!parsedWithoutData) {
    log.error("didn't expect !parsedWithoutData", [])
    throw new Error("goddamn")
  }
  const parsedArray = parsedWithoutData.toTuple();


  this.ethDepositAmount = parsedArray[2].toBigInt()
  this.l2Callvalue = parsedArray[3].toBigInt()
  this.to = parsedArray[9].toAddress()
  

  // TODO: DRY up logic used here and classic (ie abi decoding the input data)
    const lengthOfDataLength = parsedArray[10].toBigInt()
    const dataLength = parsedArray[11].toBigInt()

    const sliceStart = ethereum.encode(parsedWithoutData)!.byteLength
    if(!sliceStart) {
      // throw new Error("oh damn somethin broke")
      log.error("ah damn no encoding of start", [])
      throw new Error("goddamn2")
    }
  
    log.debug("expect slice to start at {}", [sliceStart.toString()])
    this.l2Calldata = Bytes.fromByteArray(
      Bytes.fromUint8Array(
        inputWithoutSelector.slice(
          sliceStart, sliceStart + dataLength.toI32()
        )
      )
    )
  }
}

// exported so it can be used in testing
export function handleNitroTicketCreated(event: NitroTicketCreatedEvent): void {  
    // this is set on the follow up RedeemScheduled
    // we don't currently have a good way of looking up if the tx was successful to correlate this event with a potential deposit event

    // this event is only emitted once per L1 to L2 ticket and only once in a tx
    const id = event.transaction.hash.toHexString()
    let entity = new L1ToL2Transaction(id)
  
    entity.isClassic = false
    entity.l1FromAliased = event.transaction.from

    const submitRetryableData = new SubmitRetryableInputFields(event.transaction)
    entity.deposit = submitRetryableData.ethDepositAmount
    entity.l2Callvalue = submitRetryableData.l2Callvalue
    entity.l2Calldata = submitRetryableData.l2Calldata
    entity.l2To = submitRetryableData.to

    entity.save()
}

// exported so it can be used in testing
export function handleClassicTicketCreated(event: NitroTicketCreatedEvent): void {
  // Nitro and Classic ticket creation events are backward compatible

  // this event is only emitted once per L1 to L2 ticket and only once in a tx
  const id = event.transaction.hash.toHexString()
  let entity = new L1ToL2Transaction(id)

  entity.isClassic = true
  entity.l1FromAliased = event.transaction.from

  // parsing fields from
  //   function createRetryableTicket(
  //     address destAddr,
  //     uint256 l2CallValue,
  //     uint256 maxSubmissionCost,
  //     address excessFeeRefundAddress,
  //     address callValueRefundAddress,
  //     uint256 maxGas,
  //     uint256 gasPriceBid,
  //     bytes calldata data
  // ) external payable;
  // we want to skip the `0x679b6ded` at the start and parse the bytes length instead of the bytes explicitly
  const inputWithoutSelector = Bytes.fromUint8Array(event.transaction.input.slice(4))
  const parsedWithoutData = ethereum.decode(
    "(address,uint256,uint256,address,address,uint256,uint256,uint256,uint256)",
    inputWithoutSelector
  );
  
  if (!parsedWithoutData) {
    log.critical("didn't expect !parsedWithoutData", [])
    throw new Error("somethin bad happened")
  }

  const parsedArray = parsedWithoutData.toTuple();

  const l2CallValue = parsedArray[1].toBigInt()

  // this is due to how dynamic length data types are encoded
  const lengthOfDataLength = parsedArray[7].toBigInt()
  if(lengthOfDataLength != BigInt.fromI32(256)) {
    log.critical("something unexpected went wrong with lengthOfDataLength {}", [lengthOfDataLength.toString()])
    throw new Error("oh damn somethin broke")
  }

  const dataLength = parsedArray[8].toBigInt()
  log.debug("lengthOfDataLength expected: {}", [lengthOfDataLength.toString()])
  log.debug("data length expected: {}", [dataLength.toString()])

  log.debug("input length {}", [inputWithoutSelector.length.toString()])

  // we do this because the graph seems weird when parsing dynamic length data types
  // can maybe be fixed if we don't parse it as `toTuple`
  // https://ethereum.stackexchange.com/questions/114582/the-graph-nodes-cant-decode-abi-encoded-data-containing-arrays
  const sliceStart = ethereum.encode(parsedWithoutData)!.byteLength
  if(!sliceStart) {
    // throw new Error("oh damn somethin broke")
    log.critical("something broke", []);
    return;
  }

  log.debug("expect slice to start at {}", [sliceStart.toString()])
  const l2Calldata = Bytes.fromByteArray(
    Bytes.fromUint8Array(
      inputWithoutSelector.slice(
        sliceStart, sliceStart + dataLength.toI32()
      )
    )
  )

  entity.deposit = event.transaction.value
  entity.l2Callvalue = l2CallValue
  entity.l2Calldata = l2Calldata
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash
  entity.l2To = parsedArray[0].toAddress()
  
  entity.save();
}


export function handleNitroL2ToL1Transaction(event: NitroL2ToL1TxEvent): void {
  /**
   * the classic unique id was a counter in the precompile starting from 0
   * with nitro this instead became a hash of the leaf
   * then it got changed to be a counter again (position in merkle tree) starting from 0
   * 
   * here we assume classic id gets remapped to avoid a PK clash
   * we also assume the leaf hash doesn't clash with the counter
   */

  const id = bigIntToId(event.params.position)
  let entity = new L2ToL1Transaction(id);
  entity.l2From = event.params.caller;
  entity.l1To = event.params.destination;
  entity.batchNumber = null;
  entity.indexInBatch = event.params.position;
  entity.uniqueId = event.params.position;
  // entity.l2BlockNum = event.params.arbBlockNum;
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash
  entity.l1BlockNum = event.params.ethBlockNum;
  entity.l2Timestamp = event.params.timestamp;
  entity.l1Callvalue = event.params.callvalue;
  entity.l1Calldata = event.params.data;
  entity.isClassic = false;
  entity.l2TxHash = event.transaction.hash;

  entity.save();
}

export function handleClassicL2ToL1Transaction(event: ClassicL2ToL1TransactionEvent): void {
  /**
   * the classic unique id was a counter in the precompile
   * with nitro this instead became a hash of the leaf id
   * then it got changed to be a counter again (position in merkle tree) starting from 0
   * 
   * the unique id deterministically generated from the uniqueId (sets the highest bit of the unique id as a uint64)
   * and allows us to correlate this event with the gateway's withdrawal event that uses the returned unique id
   *
   * this is equivalent to having a composite PK of `isClassic` and `uniqueId`, but subgraph schema doesn't allow us to do that
   */
  const mask = BigInt.fromI32(1).leftShift(63)
  const remappedId = mask.bitOr(event.params.uniqueId)
  const id = bigIntToId(remappedId)
  let entity = new L2ToL1Transaction(id);
  entity.l2From = event.params.caller;
  entity.l1To = event.params.destination;
  entity.batchNumber = event.params.batchNumber;
  entity.indexInBatch = event.params.indexInBatch;
  entity.uniqueId = event.params.uniqueId;
  // entity.l2BlockNum = event.params.arbBlockNum;
  entity.l2BlockNum = event.block.number
  entity.l2TxHash = event.transaction.hash
  entity.l1BlockNum = event.params.ethBlockNum;
  entity.l2Timestamp = event.params.timestamp;
  entity.l1Callvalue = event.params.callvalue;
  entity.l1Calldata = event.params.data;
  entity.isClassic = true;
  entity.l2TxHash = event.transaction.hash;

  entity.save();
}
