// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITestReceiver721 {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data) external returns (bytes4);
}

interface ITestReceiver1155 {
    function onERC1155Received(address operator, address from, uint256 id, uint256 amount, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external returns (bytes4);
}

/// Minimal ERC-721 for engine e2e: ERC-165, mint, receiver check on contracts.
contract TestNft721 {
    mapping(uint256 => address) private owners;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x80ac58cd || iid == 0x01ffc9a7;
    }

    function ownerOf(uint256 id) external view returns (address) {
        address owner = owners[id];
        require(owner != address(0), "unminted");
        return owner;
    }

    function mint(uint256 id) external {
        require(owners[id] == address(0), "minted");
        owners[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(owners[id] == from, "not owner");
        owners[id] = to;
        emit Transfer(from, to, id);
        if (to.code.length != 0) {
            bytes4 want = ITestReceiver721.onERC721Received.selector;
            require(ITestReceiver721(to).onERC721Received(msg.sender, from, id, "") == want, "refused");
        }
    }
}

/// Minimal ERC-1155 for engine e2e: ERC-165, batch reads, receiver checks.
contract TestNft1155 {
    mapping(uint256 => mapping(address => uint256)) private balances;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 amount);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] amounts);

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0xd9b67a26 || iid == 0x01ffc9a7;
    }

    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return balances[id][owner];
    }

    function balanceOfBatch(address[] calldata owners, uint256[] calldata ids) external view returns (uint256[] memory out) {
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = balances[ids[i]][owners[i]];
        }
    }

    function mint(uint256 id, uint256 amount) external {
        balances[id][msg.sender] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        balances[id][from] -= amount;
        balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        if (to.code.length != 0) {
            bytes4 want = ITestReceiver1155.onERC1155Received.selector;
            require(ITestReceiver1155(to).onERC1155Received(msg.sender, from, id, amount, "") == want, "refused");
        }
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata) external {
        require(ids.length == amounts.length, "length");
        for (uint256 i; i < ids.length; ++i) {
            balances[ids[i]][from] -= amounts[i];
            balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        if (to.code.length != 0) {
            bytes4 want = ITestReceiver1155.onERC1155BatchReceived.selector;
            require(ITestReceiver1155(to).onERC1155BatchReceived(msg.sender, from, ids, amounts, "") == want, "refused");
        }
    }
}
