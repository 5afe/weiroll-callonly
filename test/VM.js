const { expect } = require("chai")
const { ethers } = require("hardhat")
const weiroll = require("@weiroll/weiroll.js")

async function deployLibrary(name) {
  const factory = await ethers.getContractFactory(name)
  const contract = await factory.deploy()
  return weiroll.Contract.createContract(contract, 0x01)
}

const appendDecimals = (amount) => ethers.utils.parseEther(amount.toString())

describe("VM", function () {
  const testString = "Hello, world!"

  let events, vm, math, strings, stateTest, sender, revert, vmLibrary, token, payable
  let supply = ethers.BigNumber.from("100000000000000000000")
  let eventsContract

  before(async () => {
    math = await deployLibrary("Math")
    strings = await deployLibrary("Strings")
    sender = await deployLibrary("Sender")
    revert = await deployLibrary("Revert")

    const payableContract = await (await ethers.getContractFactory("Payable")).deploy()
    payable = weiroll.Contract.createContract(payableContract)

    eventsContract = await (await ethers.getContractFactory("Events")).deploy()
    events = weiroll.Contract.createContract(eventsContract, 0x01)

    const StateTest = await ethers.getContractFactory("StateTest")
    stateTest = await StateTest.deploy()

    const VM = await ethers.getContractFactory("TestableVM")
    vm = await VM.deploy()

    token = await (await ethers.getContractFactory("ExecutorToken")).deploy(supply)
  })

  function execute(commands, state) {
    let encodedCommands = commands.map(([target, func, inargs, outargs]) =>
      ethers.utils.concat([target.interface.getSighash(func), inargs, outargs, target.address])
    )
    return vm.execute(encodedCommands, state)
  }

  it("Should return msg.sender", async () => {
    const [caller] = await ethers.getSigners()
    const planner = new weiroll.Planner()
    const msgSender = planner.add(sender.sender())
    planner.add(events.logAddress(msgSender))

    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state)
    await expect(tx)
      .to.emit(eventsContract.attach(events.address), "LogAddress")
      .withArgs(vm.address)

    const receipt = await tx.wait()
    console.log(`Msg.sender: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should execute a simple addition program", async () => {
    const planner = new weiroll.Planner()
    let a = 1,
      b = 1
    for (let i = 0; i < 8; i++) {
      const ret = planner.add(math.add(a, b))
      a = b
      b = ret
    }
    planner.add(events.logUint(b))
    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state)
    await expect(tx).to.emit(eventsContract.attach(events.address), "LogUint").withArgs(55)

    const receipt = await tx.wait()
    console.log(`Array sum: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should execute a string length program", async () => {
    const planner = new weiroll.Planner()
    const len = planner.add(strings.strlen(testString))
    planner.add(events.logUint(len))
    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state)
    await expect(tx).to.emit(eventsContract.attach(events.address), "LogUint").withArgs(13)

    const receipt = await tx.wait()
    console.log(`String concatenation: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should concatenate two strings", async () => {
    const planner = new weiroll.Planner()
    const result = planner.add(strings.strcat(testString, testString))
    planner.add(events.logString(result))
    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state)
    await expect(tx)
      .to.emit(eventsContract.attach(events.address), "LogString")
      .withArgs(testString + testString)

    const receipt = await tx.wait()
    console.log(`String concatenation: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should sum an array of uints", async () => {
    const planner = new weiroll.Planner()
    const result = planner.add(math.sum([1, 2, 3]))
    planner.add(events.logUint(result))
    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state)
    await expect(tx).to.emit(eventsContract.attach(events.address), "LogUint").withArgs(6)

    const receipt = await tx.wait()
    console.log(`String concatenation: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should execute payable function", async () => {
    const amount = appendDecimals(123)
    const planner = new weiroll.Planner()

    planner.add(payable.pay().withValue(amount))
    const balance = planner.add(payable.balance())
    planner.add(events.logUintPayable(balance))
    const { commands, state } = planner.plan()

    const tx = await vm.execute(commands, state, { value: amount })
    await expect(tx).to.emit(eventsContract.attach(events.address), "LogUint").withArgs(amount)
    expect(await ethers.provider.getBalance(payable.address)).to.be.equal(amount)

    const receipt = await tx.wait()
    console.log(`Payable: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should pass and return raw state to functions", async () => {
    const commands = [
      [stateTest, "addSlots", "0x01000102feffff", "0xfe"],
      [events, "logUint", "0x0100ffffffffff", "0xff"],
    ]
    const state = [
      // dest slot index
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      // src1 slot index
      "0x0000000000000000000000000000000000000000000000000000000000000003",
      // src2 slot index
      "0x0000000000000000000000000000000000000000000000000000000000000004",
      // src1
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      // src2
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    ]

    const tx = await execute(commands, state)
    await expect(tx)
      .to.emit(eventsContract.attach(events.address), "LogUint")
      .withArgs("0x0000000000000000000000000000000000000000000000000000000000000003")

    const receipt = await tx.wait()
    console.log(`State passing: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should perform a ERC20 transfer", async () => {
    let amount = supply.div(10)
    let to = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

    /* transfer some balance to executor */
    let ttx = await token.transfer(vm.address, amount.mul(3))
    /* ensure that transfer was successful */
    await expect(ttx).to.emit(token, "Transfer").withArgs(to, vm.address, amount.mul(3))

    const commands = [[token, "transfer", "0x010001ffffffff", "0xff"]]
    const state = [
      // dest slot index
      "0x000000000000000000000000" + to.slice(2),
      // amt slot index
      ethers.utils.hexZeroPad("0x01", 32),
      // ret slot index
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]

    const tx = await execute(commands, state)
    await expect(tx).to.emit(token, "Transfer").withArgs(vm.address, to, "0x1")

    const receipt = await tx.wait()
    console.log(`Direct ERC20 transfer: ${receipt.gasUsed.toNumber()} gas`)
  })

  it("Should propagate revert reasons", async () => {
    const planner = new weiroll.Planner()

    planner.add(revert.fail())
    const { commands, state } = planner.plan()

    await expect(vm.execute(commands, state)).to.be.revertedWith("Hello World!")
  })
})
