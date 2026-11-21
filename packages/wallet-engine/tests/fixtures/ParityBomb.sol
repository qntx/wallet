// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
// A minimal TRC-20 whose transfer cost depends on block.number parity: one SSTORE loop on
// even blocks, LOOPS on odd ones. TRE refuses out-of-energy transactions at mempool
// admission (its checkTx executes the call against the current head), so a storage bump
// between prepare and approve would just bounce at broadcasthex and never reach a block.
// The parity gate exploits the one-step context gap instead: the estimate and the
// admission check both run at an even head, and the transaction lands in the next — odd —
// block where the real cost blows past fee_limit: an on-chain OUT_OF_ENERGY receipt.
contract ParityBomb {
    mapping(address => uint256) public balanceOf;
    uint256 public counter;
    uint256 public constant LOOPS = 300;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        uint256 n = block.number % 2 == 0 ? 1 : LOOPS;
        for (uint256 i = 0; i < n; i++) {
            counter += i;
        }
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
