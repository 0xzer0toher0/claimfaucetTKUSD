const { ethers } = require("ethers");
const winston = require("winston");
const readline = require("readline");
const inquirer = require("inquirer");
const chalk = require("chalk");
const { Contract, Wallet, formatUnits } = ethers;

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// Constants
const CHAIN_ID = 6342;
const EXPLORER_URL_MEGAETH = "https://explorer.megaeth.network/tx/";

// ERC20 ABI (minimal for balance checking)
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
];

// Retry logic as a standalone function
const retryLogic = async (fn, maxAttempts = 3, pauseRange = [5, 10], accountIndex) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) {
        logger.error(`${accountIndex} | Max attempts reached: ${error.message}`);
        throw error;
      }
      const pause = Math.floor(
        Math.random() * (pauseRange[1] - pauseRange[0] + 1) + pauseRange[0]
      );
      logger.warn(
        `${accountIndex} | Attempt ${attempt} failed: ${error.message}. Retrying in ${pause}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    }
  }
};

// Web3Custom class
class Web3Custom {
  constructor(providerUrl, proxy = null) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.web3 = this.provider;
    this.initializeProvider();
  }

  async initializeProvider(maxRetries = 3, retryDelay = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.provider.getNetwork();
        logger.info("Provider initialized successfully");
        return;
      } catch (error) {
        logger.warn(`Provider initialization attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          throw new Error("Failed to initialize provider after max retries");
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  async getBalance(address) {
    try {
      const balance = await this.provider.getBalance(address);
      return { ether: Number(formatUnits(balance, 18)) };
    } catch (error) {
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  async estimateGas(tx) {
    try {
      return await this.provider.estimateGas(tx);
    } catch (error) {
      throw new Error(`Failed to estimate gas: ${error.message}`);
    }
  }

  async getGasParams() {
    try {
      const feeData = await this.provider.getFeeData();
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        return {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        };
      } else {
        logger.warn("EIP-1559 data not available, using fallback gas price.");
        return { gasPrice: ethers.parseUnits("20", "gwei") };
      }
    } catch (error) {
      logger.error(`Failed to get gas parameters: ${error.message}`);
      return { gasPrice: ethers.parseUnits("20", "gwei") };
    }
  }

  async executeTransaction(txData, wallet, chainId, explorerUrl) {
    try {
      const gasLimit = await this.estimateGas(txData);
      txData.gasLimit = gasLimit;
      logger.info(`Estimated gas limit: ${gasLimit}`);

      const txResponse = await wallet.sendTransaction({
        ...txData,
        chainId,
      });

      logger.info(`Transaction sent: ${explorerUrl}${txResponse.hash}`);
      const receipt = await txResponse.wait();

      if (receipt.status === 1) {
        logger.info(
          `${explorerUrl}${txResponse.hash} | Transaction successful (Gas used: ${receipt.gasUsed})`
        );
        return txResponse.hash;
      } else {
        logger.error(`Transaction failed: ${explorerUrl}${txResponse.hash}`);
        return null;
      }
    } catch (error) {
      logger.error(`Transaction execution failed: ${error.message}`);
      throw error;
    }
  }

  async checkNetwork() {
    try {
      const network = await this.provider.getNetwork();
      if (network.chainId !== BigInt(CHAIN_ID)) {
        throw new Error(
          `Connected to wrong network. Expected chain ID ${CHAIN_ID}, but got ${network.chainId}`
        );
      }
      logger.info(`Connected to MegaETH network (chain ID: ${network.chainId})`);
    } catch (error) {
      throw new Error(`Failed to connect to network: ${error.message}`);
    }
  }
}

// Config class
class Config {
  constructor() {
    this.SETTINGS = {
      PAUSE_BETWEEN_ATTEMPTS: [5, 10],
    };
  }
}

// TekoFinance class (only for faucet)
class TekoFinance {
  constructor({
    accountIndex,
    providerUrl,
    config,
    wallet,
    proxy,
    privateKey,
  }) {
    this.accountIndex = accountIndex;
    this.web3 = new Web3Custom(providerUrl, proxy);
    this.config = config || new Config();
    this.wallet = wallet;
    this.proxy = proxy;
    this.privateKey = privateKey;

    // Define contract addresses
    const rawAddresses = {
      TKETH: "0x176735870dc6c22b4ebfbf519de2ce758de78d94",
      TKUSDC: "0xfaf334e157175ff676911adcf0964d7f54f2c424",
      TKWBTC: "0xf82ff0799448630eb56ce747db840a2e02cde4d8",
      CUSD: "0xe9b6e75c243b6100ffcb1c66e8f78f96feea727f",
    };

    // Convert all addresses to checksummed format
    this.contracts = {};
    for (const [name, address] of Object.entries(rawAddresses)) {
      try {
        this.contracts[name] = ethers.getAddress(address);
        logger.info(`${this.accountIndex} | Validated ${name} address: ${this.contracts[name]}`);
      } catch (error) {
        throw new Error(`Invalid address for ${name}: ${address} - ${error.message}`);
      }
    }
  }

  async initialize() {
    try {
      await this.web3.checkNetwork();
    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      throw error;
    }
  }

  async faucet() {
    try {
      const payloads = [
        {
          token: "tkETH",
          payload: `0x40c10f19000000000000000000000000${this.wallet.address.slice(2).toLowerCase()}0000000000000000000000000000000000000000000000000de0b6b3a7640000`,
          contract: ethers.getAddress("0x176735870dc6C22B4EBFBf519DE2ce758de78d94"),
        },
        {
          token: "tkUSDC",
          payload: `0x40c10f19000000000000000000000000${this.wallet.address.slice(2).toLowerCase()}0000000000000000000000000000000000000000000000000000000077359400`,
          contract: ethers.getAddress("0xFaf334e157175Ff676911AdcF0964D7f54F2C424"),
        },
        {
          token: "tkWBTC",
          payload: `0x40c10f19000000000000000000000000${this.wallet.address.slice(2).toLowerCase()}00000000000000000000000000000000000000000000000000000000001e8480`,
          contract: ethers.getAddress("0xF82ff0799448630eB56Ce747Db840a2E02Cde4D8"),
        },
        {
          token: "cUSD",
          payload: `0x40c10f19000000000000000000000000${this.wallet.address.slice(2).toLowerCase()}00000000000000000000000000000000000000000000003635c9adc5dea00000`,
          contract: ethers.getAddress("0xE9b6e75C243B6100ffcb1c66e8f78F96FeeA727F"),
        },
      ];

      payloads.sort(() => Math.random() - 0.5);

      for (const payload of payloads) {
        await this._requestFaucetToken(
          payload.token,
          payload.payload,
          payload.contract
        );
      }

      return true;
    } catch (error) {
      logger.error(`${this.accountIndex} | Faucet failed: ${error.message}`);
      return false;
    }
  }

  async _requestFaucetToken(tokenName, payload, contract) {
    const fn = async () => {
      logger.info(
        `${this.accountIndex} | Requesting Teko Finance faucet token: ${tokenName}`
      );

      const tx = {
        to: contract,
        data: payload,
        value: 0n,
        from: this.wallet.address,
      };

      const txHash = await this.web3.executeTransaction(
        tx,
        this.wallet,
        CHAIN_ID,
        EXPLORER_URL_MEGAETH
      );

      if (txHash) {
        logger.info(
          `${this.accountIndex} | Teko Finance ${tokenName} minted successfully!`
        );
        return true;
      } else {
        logger.error(`${this.accountIndex} | Transaction failed.`);
        return false;
      }
    };

    return await retryLogic(fn, 3, this.config.SETTINGS.PAUSE_BETWEEN_ATTEMPTS, this.accountIndex);
  }
}

// Function to prompt user for private key
function promptPrivateKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Enter your private key (without '0x'): ", (answer) => {
      rl.close();
      const privateKey = `0x${answer.trim()}`;
      resolve(privateKey);
    });
  });
}

async function showBanner() {
  console.log(
    chalk.cyanBright(`
  __  __                          _____   _____   _   _             
 |  \\/  |   ___    __ _    __ _  | ____| |_   _| | | | |          
 | |\\/| |  / _ \\  / _\` |  / _\` | |  _|     | |   | |_|      
 | |  | | |  __/ | (_| | | (_| | | |___    | |   |  _  | |
 |_|  |_|  \\___|  \\__, |  \\__,_| |_____|   |_|   |_| |_|          
                  |___/                                                                  
`)
  );
  console.log(
    chalk.yellowBright("???????????????????????????????????????????????????????????????????????")
  );
  console.log(
    chalk.greenBright("AUTO FAUCET - 0xzer0toher0")
  );
  console.log(
    chalk.magentaBright("Join Telegram: @ngadukbang")
  );
  console.log(
    chalk.yellowBright("???????????????????????????????????????????????????????????????????????")
  );
}

async function mainMenu(tekoFinance, wallet) {
  while (true) {
    const { menu } = await inquirer.prompt([
      {
        type: "list",
        name: "menu",
        message: chalk.blueBright("?? MegaETH-TEKO Auto Faucet Menu"),
        choices: [
          chalk.yellow("?? Show Wallet Balances"),
          chalk.green("?? Claim Faucet"),
          chalk.red("?? Exit"),
        ],
      },
    ]);

    if (menu.includes("Show Wallet Balances")) {
      const tokens = [
        { name: "TKETH", address: tekoFinance.contracts.TKETH, decimals: 18, color: chalk.cyan },
        { name: "TKUSDC", address: tekoFinance.contracts.TKUSDC, decimals: 6, color: chalk.green },
        { name: "TKWBTC", address: tekoFinance.contracts.TKWBTC, decimals: 8, color: chalk.yellow },
        { name: "CUSD", address: tekoFinance.contracts.CUSD, decimals: 18, color: chalk.magenta },
      ];
      console.log(chalk.bold(`\n?? Wallet Address: ${chalk.whiteBright(wallet.address)}`));
      for (const token of tokens) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        const balance = await contract.balanceOf(wallet.address);
        const formatted = Number(formatUnits(balance, token.decimals));
        console.log(token.color(`- ${token.name}: ${formatted}`));
      }
      console.log("");
    } else if (menu.includes("Claim Faucet")) {
      // Prompt for number of loops
      const { loopCount } = await inquirer.prompt([
        {
          type: "input",
          name: "loopCount",
          message: chalk.blueBright("?? How many times do you want to claim the faucet? (Enter a number):"),
          validate: (input) => {
            const num = parseInt(input);
            if (isNaN(num) || num <= 0) {
              return "Please enter a valid positive number.";
            }
            return true;
          },
        },
      ]);

      const numLoops = parseInt(loopCount);
      console.log(chalk.greenBright(`\n?? Starting faucet claim for ${numLoops} time(s)...`));

      // Looping for faucet claims without delay
      for (let i = 1; i <= numLoops; i++) {
        console.log(chalk.cyanBright(`\n?? Claim attempt ${i} of ${numLoops}`));
        const success = await tekoFinance.faucet();
        if (success) {
          console.log(chalk.greenBright(`?? Faucet claim ${i} completed successfully!`));
        } else {
          console.log(chalk.redBright(`?? Faucet claim ${i} failed.`));
        }
      }
      console.log(chalk.greenBright(`?? All ${numLoops} faucet claims completed!\n`));
    } else if (menu.includes("Exit")) {
      console.log(chalk.redBright("Bye!"));
      process.exit(0);
    }
  }
}

// Main function
async function main() {
  await showBanner();

  const providerUrl = "https://carrot.megaeth.com/rpc";

  const privateKey = await promptPrivateKey();
  if (!privateKey.match(/^0x[a-fA-F0-9]{64}$/)) {
    logger.error("Invalid private key format. It should be a 64-character hexadecimal string.");
    return;
  }

  const provider = new ethers.JsonRpcProvider(providerUrl);
  let wallet;
  try {
    wallet = new Wallet(privateKey, provider);
    logger.info(`?? Wallet Address: ${wallet.address}`);
  } catch (error) {
    logger.error(`Failed to create wallet: ${error.message}`);
    return;
  }

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(CHAIN_ID)) {
      logger.error(
        `Connected to wrong network. Expected chain ID ${CHAIN_ID}, but got ${network.chainId}`
      );
      return;
    }
  } catch (error) {
    logger.error(`Failed to connect to network: ${error.message}`);
    return;
  }

  const tekoFinance = new TekoFinance({
    accountIndex: 1,
    providerUrl,
    wallet,
    privateKey,
    proxy: null,
  });

  try {
    await tekoFinance.initialize();
    await mainMenu(tekoFinance, wallet);
  } catch (error) {
    logger.error(`Failed to execute TekoFinance operations: ${error.message}`);
  }
}

main().catch((error) => {
  logger.error(`Main execution failed: ${error.message}`);
});
