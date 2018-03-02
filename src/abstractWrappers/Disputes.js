import _ from 'lodash'

import * as ethConstants from '../constants/eth'
import * as arbitratorConstants from '../constants/arbitrator'
import * as notificationConstants from '../constants/notification'

import AbstractWrapper from './AbstractWrapper'

/**
 * Disputes API.
 */
class Disputes extends AbstractWrapper {
  // **************************** //
  // *         Events           * //
  // **************************** //

  /**
   * If there is a dispute in contract update store.
   * FIXME contracts with multiple disputes will need a way to clarify that this is a new dispute
   * @param {string} arbitratorAddress - The arbitrator contract's address.
   * @param {string} account - The account.
   */
  addDisputeEventListener = async (arbitratorAddress, account) => {
    if (!this._eventListener) return

    const _disputeCreatedHandler = async (
      event,
      contractAddress = arbitratorAddress,
      address = account
    ) => {
      const disputeId = event.args._disputeID.toNumber()
      const disputeData = await this.getDataForDispute(
        contractAddress,
        disputeId,
        account
      )
      // if listener is a party in dispute add to store
      if (disputeData.partyA === address || disputeData.partyB === address) {
        const blockNumber = event.blockNumber
        const block = this._Arbitrator._Web3Wrapper.getBlock(blockNumber)

        // add new dispute with timestamp
        await this._updateStoreForDispute(
          contractAddress,
          disputeId,
          address,
          block.timestamp * 1000
        )
      }
    }

    await this._eventListener.registerArbitratorEvent(
      'DisputeCreation',
      _disputeCreatedHandler
    )
  }

  /**
   * Add TokenShift event handler to EventListener.
   * @param {string} arbitratorAddress - The arbitrator contract's address.
   * @param {string} account - The account.
   */
  addTokenShiftToJurorProfileEventListener = async (
    arbitratorAddress,
    account
  ) => {
    if (!this._eventListener) return

    const defaultAccount = account
    const _tokenShiftHandler = async (
      event,
      contractAddress = arbitratorAddress,
      address = defaultAccount
    ) => {
      const disputeId = event.args._disputeID.toNumber()
      const account = event.args._account
      const amountShift = event.args._amount.toNumber()
      // juror won/lost tokens
      if (account === address) {
        const userProfile = await this._StoreProvider.getUserProfile(address)
        const disputeIndex = _.findIndex(
          userProfile.disputes,
          dispute =>
            dispute.disputeId === disputeId &&
            dispute.arbitratorAddress === contractAddress
        )

        // if dispute is not in store ignore
        if (disputeIndex < 0) return
        const dispute = userProfile.disputes[disputeIndex]
        await this._StoreProvider.updateDisputeProfile(
          address,
          dispute.appealDraws,
          dispute.arbitratorAddress,
          dispute.disputeId,
          (dispute.netPNK ? dispute.netPNK : 0) + amountShift
        )
      }
    }

    await this._eventListener.registerArbitratorEvent(
      'TokenShift',
      _tokenShiftHandler
    )
  }

  /**
   * Event listener that sends notification when a dispute has been ruled on.
   * @param {string} arbitratorAddress - The arbitrator contract's address.
   * @param {string} account - The users eth account.
   * @param {function} callback - <optional> function to be called when event is triggered.
   */
  addDisputeRulingHandler = async (arbitratorAddress, account, callback) => {
    if (!this._eventListener) return

    const _disputeRulingHandler = async (
      event,
      contractAddress = arbitratorAddress,
      address = account,
      notificationCallback = callback
    ) => {
      const newPeriod = event.args._period.toNumber()
      const txHash = event.transactionHash
      // send appeal possible notifications
      if (newPeriod === arbitratorConstants.PERIOD.APPEAL) {
        this._checkArbitratorWrappersSet()
        const userProfile = await this._StoreProvider.getUserProfile(address)
        // contract data
        const arbitratorData = await this._Arbitrator.getData(
          contractAddress,
          address
        )
        let disputeId = 0
        const currentSession = arbitratorData.session

        let dispute
        while (1) {
          // iterate over all disputes (FIXME inefficient)
          try {
            try {
              dispute = await this._Arbitrator.getDispute(
                contractAddress,
                disputeId
              )
              // eslint-disable-next-line no-unused-vars
            } catch (err) {
              // FIXME standardize
              throw new Error('DisputeOutOfRange')
            }

            if (dispute.arbitratedContract === ethConstants.NULL_ADDRESS) break
            // session + number of appeals
            const disputeSession =
              dispute.firstSession + dispute.numberOfAppeals
            // if dispute not in current session skip
            if (disputeSession !== currentSession) {
              disputeId++
              continue
            }

            const ruling = await this._Arbitrator.currentRulingForDispute(
              contractAddress,
              disputeId,
              dispute.numberOfAppeals
            )

            if (
              _.findIndex(
                userProfile.disputes,
                dispute =>
                  dispute.disputeId === disputeId &&
                  dispute.arbitratorAddress === contractAddress
              ) >= 0
            ) {
              const notification = await this._StoreProvider.newNotification(
                address,
                txHash,
                disputeId, // use disputeId instead of logIndex since it doens't have its own event
                notificationConstants.TYPE.APPEAL_POSSIBLE,
                'A ruling has been made. Appeal is possible',
                {
                  disputeId,
                  contractAddress,
                  ruling
                }
              )
              // get ruledAt from block timestamp
              const blockNumber = event.blockNumber
              const block = this._Arbitrator._Web3Wrapper.getBlock(blockNumber)
              // add ruledAt to store
              await this._updateStoreForDispute(
                contractAddress,
                disputeId,
                address,
                null,
                block.timestamp * 1000
              )

              if (notificationCallback && notification) {
                notificationCallback(notification[0])
              }
            }
            // check next dispute
            disputeId += 1
          } catch (err) {
            if (err === 'DisputeOutOfRange') break
            throw err
          }
        }
      }
    }

    await this._eventListener.registerArbitratorEvent(
      'NewPeriod',
      _disputeRulingHandler
    )
  }

  // **************************** //
  // *          Public          * //
  // **************************** //

  /**
   * Pay the arbitration fee to raise a dispute. To be called by the party A.
   * @param {string} account - Ethereum account.
   * @param {string} arbitrableContractAddress - Address address of arbitrable contract.
   * @param {number} [arbitrationCost=DEFAULT_ARBITRATION_FEE] - Amount to pay the arbitrator.
   * @returns {string} - txHash hash transaction | Error.
   */
  raiseDisputePartyA = async (
    account,
    arbitrableContractAddress,
    arbitrationCost = arbitratorConstants.DEFAULT_ARBITRATION_FEE
  ) => {
    this._checkArbitrableWrappersSet()

    try {
      const txHash = await this._ArbitrableContract.payArbitrationFeeByPartyA(
        account,
        arbitrableContractAddress,
        arbitrationCost
      )

      if (!txHash) throw new Error('unable to pay arbitration fee for party A')
      return txHash
    } catch (err) {
      throw new Error(err)
    }
  }

  /**
   * Pay the arbitration fee to raise a dispute. To be called by the party B.
   * @param {string} account - Ethereum account.
   * @param {string} arbitrableContractAddress - Address address of arbitrable contract.
   * @param {number} [arbitrationCost=DEFAULT_ARBITRATION_FEE] - Amount to pay the arbitrator.
   * @returns {string} - txHash hash of the transaction | Error.
   */
  raiseDisputePartyB = async (
    account,
    arbitrableContractAddress,
    arbitrationCost = arbitratorConstants.DEFAULT_ARBITRATION_FEE
  ) => {
    this._checkArbitrableWrappersSet()

    const txHash = await this._ArbitrableContract.payArbitrationFeeByPartyB(
      account,
      arbitrableContractAddress,
      arbitrationCost
    )

    if (!txHash) throw new Error('unable to pay arbitration fee for party B')
    return txHash
  }

  /**
   * Get disputes for user with extra data from arbitrated transaction and store
   * @param {string} arbitratorAddress address of Kleros contract
   * @param {string} account address of user
   * @returns {object[]} dispute data objects for user
   */
  getDisputesForUser = async (arbitratorAddress, account) => {
    // FIXME don't like having to call this every fnc
    this._checkArbitratorWrappersSet()
    this._checkArbitrableWrappersSet()
    // contract data
    const arbitratorData = await this._Arbitrator.getData(
      arbitratorAddress,
      account
    )

    // fetch user profile
    let profile = await this._StoreProvider.setUpUserProfile(account)
    // fetch current contract period
    const period = arbitratorData.period
    const currentSession = arbitratorData.session
    // new jurors have not been chosen yet. don't update

    const _getDisputesForUserFromStore = async account => {
      let disputes = await this._StoreProvider.getDisputesForUser(account)
      disputes = await Promise.all(
        disputes.map(dispute =>
          this.getDataForDispute(
            dispute.arbitratorAddress,
            dispute.disputeId,
            account
          )
        )
      )

      return disputes
    }

    if (period !== arbitratorConstants.PERIOD.VOTE) {
      return _getDisputesForUserFromStore(account)
    }

    if (currentSession !== profile.session) {
      // get disputes for juror
      const myDisputeIds = await this.getDisputesForJuror(
        arbitratorAddress,
        account
      )
      // update store for each dispute
      await Promise.all(
        myDisputeIds.map(async disputeId => {
          // add dispute to db if it doesn't already exist
          await this._updateStoreForDispute(
            arbitratorAddress,
            disputeId,
            account
          )
        })
      )

      // update session on profile
      profile = await this._StoreProvider.getUserProfile(account)
      profile.session = currentSession
      await this._StoreProvider.updateUserProfile(account, profile)
    }

    return _getDisputesForUserFromStore(account)
  }

  /**
   * Get disputes from Kleros contract.
   * @param {string} arbitratorAddress - Address of Kleros contract.
   * @param {string} account - Address of user.
   * @returns {int[]} - Array of dispute id's.
   */
  getDisputesForJuror = async (arbitratorAddress, account) => {
    // FIXME don't like having to call this every fnc
    this._checkArbitratorWrappersSet()
    // contract data
    const arbitratorData = await this._Arbitrator.getData(
      arbitratorAddress,
      account
    )
    const myDisputes = []
    let disputeId = 0
    const currentSession = arbitratorData.session

    let dispute
    while (1) {
      // iterate over all disputes (FIXME inefficient)
      // IDEA iterate over DisputeCreated events between last session and this session
      try {
        dispute = await this._Arbitrator.getDispute(
          arbitratorAddress,
          disputeId
        )
        if (dispute.arbitratedContract === ethConstants.NULL_ADDRESS) break
        // session + number of appeals
        const disputeSession = dispute.firstSession + dispute.numberOfAppeals
        // if dispute not in current session skip
        if (disputeSession !== currentSession) {
          disputeId++
          dispute = await this._Arbitrator.getDispute(
            arbitratorAddress,
            disputeId
          )
          continue
        }

        const draws = await this.getDrawsForJuror(
          arbitratorAddress,
          disputeId,
          account
        )
        if (draws.length > 0) {
          myDisputes.push(disputeId)
        }
        // check next dispute
        disputeId += 1
        // eslint-disable-next-line no-unused-vars
      } catch (err) {
        break
      }
    }

    return myDisputes
  }

  /**
   * Fetch the votes a juror has in a dispute.
   * @param {string} arbitratorAddress - Address of the arbitrator contract.
   * @param {number} disputeId - ID of the dispute.
   * @param {string} account - Potential jurors address.
   * @returns {number[]} - Array of integers indicating the draw.
   */
  getDrawsForJuror = async (arbitratorAddress, disputeId, account) => {
    const numberOfJurors = await this._Arbitrator.getAmountOfJurorsForDispute(
      arbitratorAddress,
      disputeId
    )
    const draws = []
    for (let draw = 1; draw <= numberOfJurors; draw++) {
      const isJuror = await this._Arbitrator.isJurorDrawnForDispute(
        disputeId,
        draw,
        arbitratorAddress,
        account
      )
      if (isJuror) {
        draws.push(draw)
      }
    }
    return draws
  }

  /**
   * Submit votes. Note can only be called during Voting period (Period 2).
   * @param {string} arbitratorAddress - Address of KlerosPOC contract.
   * @param {number} disputeId - Index of the dispute.
   * @param {number} ruling - Int representing the jurors decision.
   * @param {number[]} draws - Int[] of drawn votes for dispute.
   * @param {string} account - Address of user.
   * @returns {string} - Transaction hash | Error.
   */
  submitVotesForDispute = async (
    arbitratorAddress,
    disputeId,
    ruling,
    draws,
    account
  ) => {
    const txHash = await this._Arbitrator.submitVotes(
      arbitratorAddress,
      disputeId,
      ruling,
      draws,
      account
    )

    if (txHash) {
      return txHash
    } else {
      throw new Error('unable to submit votes')
    }
  }

  /**
   * Gets the deadline for an arbitrator's period, which is also the deadline for all its disputes.
   * @param {string} arbitratorAddress - The address of the arbitrator contract.
   * @param {number} [period=PERIODS.VOTE] - The period to get the deadline for.
   * @returns {number} - epoch timestamp
   */
  getDeadlineForDispute = async (
    arbitratorAddress,
    period = arbitratorConstants.PERIOD.VOTE
  ) => {
    // Get arbitrator data
    const arbitratorData = await this._Arbitrator.getData(arbitratorAddress)

    // Last period change + current period duration = deadline
    const result =
      1000 *
      (arbitratorData.lastPeriodChange +
        (await this._Arbitrator.getTimeForPeriod(arbitratorAddress, period)))

    return result
  }

  /**
   * update store with new dispute data
   * @param {string} arbitratorAddress Address address of arbitrator contract
   * @param {int} disputeId index of dispute
   * @param {string} account address of party to update dispute or
   * @param {number} createdAt <optional> epoch timestamp of when dispute was created
   * @param {number} ruledAt <optional> epoch timestamp of when dispute was ruled on
   * @returns {object} updated dispute object
   */
  _updateStoreForDispute = async (
    arbitratorAddress,
    disputeId,
    account,
    createdAt,
    ruledAt
  ) => {
    const disputeData = await this.getDataForDispute(
      arbitratorAddress,
      disputeId,
      account
    )

    if (createdAt)
      disputeData.appealCreatedAt[disputeData.numberOfAppeals] = createdAt
    if (ruledAt)
      disputeData.appealRuledAt[disputeData.numberOfAppeals] = ruledAt

    // update dispute
    const dispute = await this._StoreProvider.updateDispute(
      disputeData.disputeId,
      disputeData.arbitratorAddress,
      disputeData.arbitrableContractAddress,
      disputeData.partyA,
      disputeData.partyB,
      disputeData.title,
      disputeData.status,
      disputeData.information,
      disputeData.justification,
      disputeData.resolutionOptions,
      disputeData.appealCreatedAt,
      disputeData.appealRuledAt
    )

    const storedDisputeData = await this._StoreProvider.getDisputeData(
      arbitratorAddress,
      disputeId,
      account
    )

    const currentSession = await this._Arbitrator.getSession(arbitratorAddress)
    if (disputeData.lastSession === currentSession) {
      const sessionDraws = await this.getDrawsForJuror(
        arbitratorAddress,
        disputeId,
        account
      )

      if (!storedDisputeData.appealDraws) storedDisputeData.appealDraws = []
      storedDisputeData.appealDraws[disputeData.numberOfAppeals] = sessionDraws
    }

    // update profile for account
    await this._StoreProvider.updateDisputeProfile(
      account,
      storedDisputeData.appealDraws,
      disputeData.arbitratorAddress,
      disputeData.disputeId,
      disputeData.netPNK ? disputeData.netPNK : 0
    )

    return dispute
  }

  /**
   * Get user data for a dispute from the store.
   * @param {string} arbitratorAddress - Address for arbitrator contract.
   * @param {int} disputeId - Index of dispute.
   * @param {string} account - Jurors address.
   * @returns {object} - Dispute data from store for user.
   */
  getUserDisputeFromStore = async (arbitratorAddress, disputeId, account) => {
    const userProfile = await this._StoreProvider.getUserProfile(account)

    const disputeArray = _.filter(
      userProfile.disputes,
      dispute =>
        dispute.disputeId === disputeId &&
        dispute.arbitratorAddress === arbitratorAddress
    )

    if (_.isEmpty(disputeArray))
      throw new Error(`User ${account} does not have store data for dispute`)

    return disputeArray[0]
  }

  /**
   * Get evidence for contract.
   * @param {string} arbitrableContractAddress - Address of arbitrable contract.
   * @returns {object[]} - Array of evidence objects.
   */
  getEvidenceForArbitrableContract = async arbitrableContractAddress => {
    this._checkArbitrableWrappersSet()

    const arbitrableContractData = await this._ArbitrableContract.getData(
      arbitrableContractAddress
    )
    const partyAContractData = await this._StoreProvider.getContractByAddress(
      arbitrableContractData.partyA,
      arbitrableContractAddress
    )
    const partyBContractData = await this._StoreProvider.getContractByAddress(
      arbitrableContractData.partyB,
      arbitrableContractAddress
    )

    const partyAEvidence = (partyAContractData
      ? partyAContractData.evidences
      : []
    ).map(evidence => {
      evidence.submitter = arbitrableContractData.partyA
      return evidence
    })
    const partyBEvidence = (partyBContractData
      ? partyBContractData.evidences
      : []
    ).map(evidence => {
      evidence.submitter = arbitrableContractData.partyB
      return evidence
    })

    return partyAEvidence.concat(partyBEvidence)
  }

  /**
   * Get ruling options for dispute.
   * @param {string} arbitratorAddress - Address of arbitrator contract.
   * @param {string} disputeId - Dispute ID.
   * @returns {object[]} - Array of ruling objects.
   */
  getRulingOptions = async (arbitratorAddress, disputeId) => {
    const dispute = await this._Arbitrator.getDispute(
      arbitratorAddress,
      disputeId
    )
    if (!dispute) {
      throw new Error(
        `Cannot fetch ruling options: Dispute from arbitrator ${arbitratorAddress} with disputeId: ${disputeId} does not exist`
      )
    }
    const arbitrableContractAddress = dispute.arbitratedContract

    return this._ArbitrableContract.getRulingOptions(
      arbitrableContractAddress,
      arbitratorAddress,
      disputeId
    )
  }

  /**
   * Get data for a dispute.
   * @param {string} arbitratorAddress - Address for arbitrator contract.
   * @param {number} disputeId - Index of dispute.
   * @param {string} account - Juror account address.
   * @returns {object} - Data object for dispute that uses data from the contract and store.
   */
  getDataForDispute = async (arbitratorAddress, disputeId, account) => {
    this._checkArbitratorWrappersSet()
    this._checkArbitrableWrappersSet()

    // FIXME should we just return what we have in the store?
    const dispute = await this._Arbitrator.getDispute(
      arbitratorAddress,
      disputeId
    )
    if (!dispute) {
      throw new Error(
        `Dispute with arbitrator: ${arbitratorAddress} and disputeId: ${disputeId} does not exist`
      )
    }
    const arbitrableContractAddress = dispute.arbitratedContract

    const arbitrableContractData = await this._ArbitrableContract.getData(
      arbitrableContractAddress
    )
    const constractStoreData = await this._StoreProvider.getContractByAddress(
      arbitrableContractData.partyA,
      arbitrableContractAddress
    )

    let appealDraws = []
    let netPNK = 0
    let appealCreatedAt = []
    let appealRuledAt = []
    if (account) {
      try {
        const userData = await this._StoreProvider.getDisputeData(
          arbitratorAddress,
          disputeId,
          account
        )
        appealDraws = userData.appealDraws || []
        netPNK = userData.netPNK || 0
        appealCreatedAt = userData.appealCreatedAt || []
        appealRuledAt = userData.appealRuledAt || []
        // eslint-disable-next-line no-unused-vars
      } catch (err) {
        // fetching dispute will fail if it hasn't been added to the store yet. this is ok we can just not return store data
      }
    }

    // get evidence
    const evidence = await this.getEvidenceForArbitrableContract(
      arbitrableContractAddress
    )

    const firstSession = dispute.firstSession
    const lastSession = dispute.firstSession + dispute.numberOfAppeals
    // NOTE arrays indexed by appeal number
    const appealRulings = []
    const appealJuror = []
    for (let appeal = 0; appeal <= lastSession - firstSession; appeal++) {
      // get ruling for appeal. Note appeal 0 is first session
      const ruling = await this._Arbitrator.currentRulingForDispute(
        arbitratorAddress,
        disputeId,
        appeal
      )

      appealRulings[appeal] = {
        ruling,
        voteCounter: dispute.voteCounters[appeal],
        ruledAt: appealRuledAt[appeal],
        deadline: await this.getDeadlineForDispute(arbitratorAddress, appeal)
      }

      const baseFee = dispute.arbitrationFeePerJuror
      const draws = appealDraws[appeal] || []
      let canRule = false
      if (appeal === lastSession && draws.length > 0) {
        canRule = await this._Arbitrator.canRuleDispute(
          account,
          disputeId,
          draws
        )
      }

      appealJuror[appeal] = {
        fee: baseFee * draws.length,
        draws,
        canRule
      }
    }

    return {
      // Arbitrable Contract Data
      arbitrableContractAddress,
      arbitrableContractStatus: arbitrableContractData.status,
      arbitratorAddress,
      partyA: arbitrableContractData.partyA,
      partyB: arbitrableContractData.partyB,

      // Dispute Data
      disputeId,
      firstSession,
      lastSession,
      numberOfAppeals: dispute.numberOfAppeals,
      disputeState: dispute.state,
      disputeStatus: dispute.status,
      appealRulings,
      appealJuror,

      // Store Data
      description: constractStoreData
        ? constractStoreData.description
        : undefined,
      email: constractStoreData ? constractStoreData.email : undefined,
      evidence,
      netPNK,
      appealCreatedAt,
      appealRuledAt
    }
  }
}

export default Disputes
