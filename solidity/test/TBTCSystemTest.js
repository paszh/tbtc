const {deployAndLinkAll} = require("./helpers/testDeployer.js")
const {increaseTime, expectEvent} = require("./helpers/utils.js")
const {createSnapshot, restoreSnapshot} = require("./helpers/snapshot.js")
const {accounts, contract, web3} = require("@openzeppelin/test-environment")
const {BN, expectRevert} = require("@openzeppelin/test-helpers")
const {expect} = require("chai")

const TBTCSystem = contract.fromArtifact("TBTCSystem")
const SatWeiPriceFeed = contract.fromArtifact("SatWeiPriceFeed")
const MockMedianizer = contract.fromArtifact("MockMedianizer")

describe("TBTCSystem", async function() {
  let tbtcSystem
  let ecdsaKeepFactory
  let tdt
  let ethBtcMedianizer
  let badEthBtcMedianizer
  let newEthBtcMedianizer
  const NEW_PRICE_FEED_VALUE = 1234123412344

  const nonSystemOwner = accounts[3]

  before(async () => {
    const {
      tbtcSystemStub,
      ecdsaKeepFactoryStub,
      tbtcDepositToken,
      mockSatWeiPriceFeed,
    } = await deployAndLinkAll(
      [],
      // Though deployTestDeposit deploys a TBTCSystemStub for us, we want to
      // test TBTCSystem itself.
      {
        TBTCSystemStub: TBTCSystem,
        MockSatWeiPriceFeed: SatWeiPriceFeed,
      },
    )
    // Refer to this correctly throughout the rest of the test.
    tbtcSystem = tbtcSystemStub
    ecdsaKeepFactory = ecdsaKeepFactoryStub
    tdt = tbtcDepositToken

    ethBtcMedianizer = await MockMedianizer.new()
    await ethBtcMedianizer.setValue(100000000000)
    mockSatWeiPriceFeed.initialize(tbtcSystem.address, ethBtcMedianizer.address)

    badEthBtcMedianizer = await MockMedianizer.new()
    await badEthBtcMedianizer.setValue(0)
    newEthBtcMedianizer = await MockMedianizer.new()
    await newEthBtcMedianizer.setValue(NEW_PRICE_FEED_VALUE)
  })

  describe("requestNewKeep()", async () => {
    let openKeepFee
    const tdtOwner = accounts[1]
    const keepOwner = accounts[2]
    const maxSecuredLifetime = 123

    before(async () => {
      openKeepFee = await ecdsaKeepFactory.openKeepFeeEstimate.call()
      await tdt.forceMint(tdtOwner, web3.utils.toBN(keepOwner))
    })

    it("sends caller as owner to open new keep", async () => {
      await tbtcSystem.requestNewKeep(5, 10, 0, maxSecuredLifetime, {
        from: keepOwner,
        value: openKeepFee,
      })
      const actualKeepOwner = await ecdsaKeepFactory.keepOwner.call()

      expect(keepOwner, "incorrect keep owner address").to.equal(
        actualKeepOwner,
      )
    })

    it("returns keep address", async () => {
      const expectedKeepAddress = await ecdsaKeepFactory.keepAddress.call()

      const result = await tbtcSystem.requestNewKeep.call(
        5,
        10,
        0,
        maxSecuredLifetime,
        {
          value: openKeepFee,
          from: keepOwner,
        },
      )

      expect(expectedKeepAddress, "incorrect keep address").to.equal(result)
    })

    it("forwards value to keep factory", async () => {
      const initialBalance = await web3.eth.getBalance(ecdsaKeepFactory.address)

      await tbtcSystem.requestNewKeep(5, 10, 0, maxSecuredLifetime, {
        value: openKeepFee,
        from: keepOwner,
      })

      const finalBalance = await web3.eth.getBalance(ecdsaKeepFactory.address)
      const balanceCheck = new BN(finalBalance).sub(new BN(initialBalance))
      expect(
        balanceCheck,
        "TBTCSystem did not correctly forward value to keep factory",
      ).to.eq.BN(openKeepFee)
    })

    it("reverts if caller does not match a valid TDT", async () => {
      await expectRevert(
        tbtcSystem.requestNewKeep(5, 10, 0, maxSecuredLifetime, {
          value: openKeepFee,
          from: accounts[0],
        }),
        "Caller must be a Deposit contract",
      )
    })

    it("reverts if caller is the owner of a valid TDT", async () => {
      await expectRevert(
        tbtcSystem.requestNewKeep(5, 10, 0, maxSecuredLifetime, {
          value: openKeepFee,
          from: tdtOwner,
        }),
        "Caller must be a Deposit contract",
      )
    })
  })

  function governanceTest({
    property,
    change,
    timeDelayGetter,
    goodParametersWithName,
    badInitializationTests,
    verifyFinalization,
    badFinalizationTests,
  }) {
    timeDelayGetter = timeDelayGetter || "getGovernanceTimeDelay"
    badInitializationTests = badInitializationTests || {}
    badFinalizationTests = badFinalizationTests || {}

    function parametersAsList(parametersWithName) {
      const parametersList = []
      for (let i = 0; i < parametersWithName.length; ++i) {
        parametersList[i] = parametersWithName[i].value
      }

      return parametersList
    }
    function parametersAsObject(parametersWithName) {
      const parametersObject = []
      for (let i = 0; i < parametersWithName.length; ++i) {
        parametersObject[parametersWithName[i].name] =
          parametersWithName[i].value
      }

      return parametersObject
    }

    function tweakParameters(parametersWithName) {
      const newParametersWithName = []

      for (let i = 0; i < parametersWithName.length; ++i) {
        const {name, value} = parametersWithName[i]
        let updatedValue = value
        if (value instanceof BN) {
          updatedValue = value.add(new BN(1))
        } else if (typeof value == "number") {
          updatedValue = value + 1
        } else if (value instanceof String && value.startsWith("0x")) {
          // Assume address, generate one.
          updatedValue = "0x"
          for (let j = 0; j < 20; ++i) {
            updatedValue += (
              "0" + Math.floor(Math.random() * 255).toString("hex")
            ).substr(-2)
          }
        }

        newParametersWithName.push({name: name, value: updatedValue})
      }

      return [
        parametersAsObject(newParametersWithName),
        parametersAsList(newParametersWithName),
      ]
    }

    const goodParameters = parametersAsList(goodParametersWithName)
    const goodParametersByName = parametersAsObject(goodParametersWithName)

    async function invoke(prefix, suffix, params) {
      const fn = tbtcSystem[`${prefix || ""}${change}${suffix || ""}`]
      if (!fn) {
        console.error(`${prefix}${change}${suffix}`)
      }
      return fn.apply(tbtcSystem, params)
    }

    describe(`when updating ${property}`, async () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      describe("when initiating the update", async () => {
        it("executes and fires the update start event", async () => {
          const receipt = await invoke("begin", "", goodParameters)

          expectEvent(receipt, `${change}Started`, goodParametersByName)
        })

        it("overrides previous update and resets timer", async () => {
          await invoke("begin", "", goodParameters)
          await increaseTime(50)

          const governanceTime = await tbtcSystem[timeDelayGetter].call()

          const [updatedParametersByName, updatedParameters] = tweakParameters(
            goodParametersWithName,
          )
          const receipt = await invoke("begin", "", updatedParameters)
          const remainingTime = await invoke("getRemaining", "Time")

          expectEvent(receipt, `${change}Started`, updatedParametersByName)
          expect([
            remainingTime.toString(),
            remainingTime.toString() - 1,
          ]).to.include(governanceTime.toString())
        })

        it("reverts if msg.sender != owner", async () => {
          await expectRevert.unspecified(
            invoke("begin", "", goodParameters.concat([{from: accounts[1]}])),
          )
        })

        for (const [scenario, props] of Object.entries(
          badInitializationTests,
        )) {
          const {parameters, error} = props

          it(`reverts when ${scenario}`, async () => {
            await expectRevert(invoke("begin", "", parameters), error)
          })
        }
      })

      describe("when finalizing the update", async () => {
        it("reverts if the governance timer has not elapsed", async () => {
          await invoke("begin", "", goodParameters)

          await expectRevert(
            invoke("finalize"),
            "Governance delay has not elapsed.",
          )
        })

        it("reverts if a change has not been initiated", async () => {
          await expectRevert(invoke("finalize"), "Change not initiated.")
        })

        for (const [scenario, props] of Object.entries(badFinalizationTests)) {
          const {beforeFinalizing, parameters, error} = props

          it(`reverts when ${scenario}`, async () => {
            await invoke("begin", "", parameters)
            const remainingTime = await invoke("getRemaining", "Time")
            await increaseTime(remainingTime.toNumber() + 1)

            if (beforeFinalizing) {
              await beforeFinalizing()
            }

            await expectRevert(invoke("finalize"), error)
          })
        }

        it(`updates ${property} and fires event if the governance timer has elapsed`, async () => {
          await invoke("begin", "", goodParameters)
          const remainingTime = await invoke("getRemaining", "Time")
          await increaseTime(remainingTime.toNumber() + 1)

          const receipt = await invoke("finalize")
          await verifyFinalization(receipt, ...goodParameters)
        })
      })
    })
  }

  describe("emergencyPauseNewDeposits", async () => {
    let term

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("pauses new deposit creation", async () => {
      await tbtcSystem.emergencyPauseNewDeposits()

      const allowNewDeposits = await tbtcSystem.getAllowNewDeposits()
      expect(allowNewDeposits).to.equal(false)
    })

    it("reverts if msg.sender is not owner", async () => {
      await expectRevert(
        tbtcSystem.emergencyPauseNewDeposits({from: nonSystemOwner}),
        "Ownable: caller is not the owner",
      )
    })

    it("does not allows new deposit re-activation before 10 days", async () => {
      await tbtcSystem.emergencyPauseNewDeposits()
      term = await tbtcSystem.getRemainingPauseTerm()

      await increaseTime(term.toNumber() - 10) // T-10 seconds. toNumber because increaseTime doesn't support BN

      await expectRevert(
        tbtcSystem.resumeNewDeposits(),
        "Deposits are still paused",
      )
    })

    it("allows new deposit creation after 10 days", async () => {
      await tbtcSystem.emergencyPauseNewDeposits()
      term = await tbtcSystem.getRemainingPauseTerm()

      await increaseTime(term.toNumber()) // 10 days
      await tbtcSystem.resumeNewDeposits()
      const allowNewDeposits = await tbtcSystem.getAllowNewDeposits()
      expect(allowNewDeposits).to.equal(true)
    })

    it("reverts if emergencyPauseNewDeposits has already been called", async () => {
      await tbtcSystem.emergencyPauseNewDeposits()
      term = await tbtcSystem.getRemainingPauseTerm()

      await increaseTime(term.toNumber()) // 10 days
      tbtcSystem.resumeNewDeposits()

      await expectRevert(
        tbtcSystem.emergencyPauseNewDeposits(),
        "emergencyPauseNewDeposits can only be called once",
      )
    })
  })

  before(async () => {
    governanceTest({
      property: "signer fee",
      change: "SignerFeeDivisorUpdate",
      goodParametersWithName: [{name: "_signerFeeDivisor", value: new BN(200)}],
      badInitializationTests: {
        "smaller than or equal to 9": {
          parameters: [9],
          error:
            "Signer fee divisor must be greater than 9, for a signer fee that is <= 10%.",
        },
        "greater than or equal to 2000": {
          parameters: [2000],
          error:
            "Signer fee divisor must be less than 2000, for a signer fee that is > 0.05%.",
        },
      },
      verifyFinalization: async (receipt, setDivisor) => {
        expectEvent(receipt, "SignerFeeDivisorUpdated", {
          _signerFeeDivisor: setDivisor,
        })

        expect(await tbtcSystem.getSignerFeeDivisor()).to.eq.BN(setDivisor)
      },
    })

    governanceTest({
      property: "lot sizes",
      change: "LotSizesUpdate",
      goodParametersWithName: [
        {
          name: "_lotSizes",
          value: [
            new BN(10 ** 8), // required
            new BN(10 ** 6),
            new BN(10 ** 9), // upper bound
            new BN(50 * 10 ** 3), // lower bound
          ],
        },
      ],
      badInitializationTests: {
        "array is empty": {
          parameters: [[]],
          error: "Lot size array must always contain 1 BTC.",
        },
        "array does not contain a 1 BTC lot size": {
          parameters: [[10 ** 7]],
          error: "Lot size array must always contain 1 BTC.",
        },
        "array contains a lot size < 0.0005 BTC": {
          parameters: [[10 ** 7, 10 ** 8, 5 * 10 ** 3 - 1]],
          error: "Lot sizes less than 0.0005 BTC are not allowed",
        },
        "array contains a lot size > 10 BTC": {
          parameters: [[10 ** 7, 10 ** 9 + 1, 10 ** 8]],
          error: "Lot sizes greater than 10 BTC are not allowed",
        },
      },
      verifyFinalization: async (receipt, setLotSizes) => {
        expectEvent(receipt, "LotSizesUpdated", {_lotSizes: setLotSizes})

        const lotSizes = await tbtcSystem.getAllowedLotSizes()
        lotSizes.forEach((_, i) => expect(_).to.eq.BN(setLotSizes[i]))
      },
    })
    governanceTest({
      property: "collateralization thresholds",
      change: "CollateralizationThresholdsUpdate",
      goodParametersWithName: [
        {name: "_initialCollateralizedPercent", value: new BN(213)},
        {name: "_undercollateralizedThresholdPercent", value: new BN(156)},
        {
          name: "_severelyUndercollateralizedThresholdPercent",
          value: new BN(128),
        },
      ],
      badInitializationTests: {
        "contain initial collateralized percent > 300": {
          parameters: [301, 130, 120],
          error: "a",
        },
        "contain initial collateralized percent < 100": {
          parameters: [99, 130, 120],
          error: "b",
        },
        "contain undercollateralized threshold > initial collateralized percent": {
          parameters: [150, 160, 120],
          error:
            "Undercollateralized threshold must be < initial collateralized percent",
        },
        "contain severe undercollateralized threshold > undercollateralized threshold": {
          parameters: [150, 130, 131],
          error:
            "Severe undercollateralized threshold must be < undercollateralized threshold",
        },
      },
      verifyFinalization: async (
        receipt,
        setInitial,
        setUnder,
        setSeverelyUnder,
      ) => {
        expectEvent(receipt, "CollateralizationThresholdsUpdated", {
          _initialCollateralizedPercent: setInitial,
          _undercollateralizedThresholdPercent: setUnder,
          _severelyUndercollateralizedThresholdPercent: setSeverelyUnder,
        })

        expect(await tbtcSystem.getInitialCollateralizedPercent()).to.eq.BN(
          setInitial,
        )
        expect(
          await tbtcSystem.getUndercollateralizedThresholdPercent(),
        ).to.eq.BN(setUnder)
        expect(
          await tbtcSystem.getSeverelyUndercollateralizedThresholdPercent(),
        ).to.eq.BN(setSeverelyUnder)
      },
    })

    governanceTest({
      property: "adding an ETHBTC feeds",
      change: "EthBtcPriceFeedAddition",
      timeDelayGetter: "getPriceFeedGovernanceTimeDelay",
      goodParametersWithName: [
        {name: "_priceFeed", value: newEthBtcMedianizer.address},
      ],
      badInitializationTests: {
        "adding inactive feed": {
          parameters: [badEthBtcMedianizer.address],
          error: "Cannot add inactive feed",
        },
        // finalization
      },
      verifyFinalization: async (receipt, newFeedAddress) => {
        // disable current feed
        await ethBtcMedianizer.setValue(0)

        // check new feed
        expect(await tbtcSystem.fetchBitcoinPrice()).to.eq.BN(
          new BN(10).pow(new BN(28)).div(new BN(NEW_PRICE_FEED_VALUE)),
        )

        expectEvent(receipt, "EthBtcPriceFeedAdded", {
          _priceFeed: newFeedAddress,
        })
      },
      badFinalizationTests: {
        "finalizing inactive feed": {
          parameters: [newEthBtcMedianizer.address],
          beforeFinalizing: async () => newEthBtcMedianizer.setValue(0),
          error: "Cannot add inactive feed",
        },
      },
    })
  })

  describe("setFullyBackedKeepFactory", async () => {
    const factory = "0xABCDEABCDEABCDEABCDEABCDEABCDEABCDEABCDE"

    it("can be called only by the owner", async () => {
      await expectRevert(
        tbtcSystem.setFullyBackedKeepFactory(factory, {from: nonSystemOwner}),
        "Ownable: caller is not the owner.",
      )

      await tbtcSystem.setFullyBackedKeepFactory(factory)
      // ok, no reverts
    })
  })

  describe("setKeepFactorySelector", async () => {
    const selector = "0xFFCDEABCDEABCDEABCDEABCDEABCDEABCDEABCDE"

    it("can be called only by the owner", async () => {
      await expectRevert(
        tbtcSystem.setKeepFactorySelector(selector, {from: nonSystemOwner}),
        "Ownable: caller is not the owner.",
      )

      await tbtcSystem.setKeepFactorySelector(selector)
      // ok, no reverts
    })
  })
})
