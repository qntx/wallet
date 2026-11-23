// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Minimal ERC-721 for the approvals e2e: mint, approve, getApproved,
/// setApprovalForAll, isApprovedForAll, ownerOf, transferFrom with the
/// standard events so the discovery scan sees them.
contract TestCollectibles {
    string public name = "Test Collectibles";
    string public symbol = "TCOL";
    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function mint(address to, uint256 tokenId) external {
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _ownerOf[tokenId];
    }

    function approve(address approved, uint256 tokenId) external {
        require(_ownerOf[tokenId] == msg.sender, "not owner");
        _approved[tokenId] = approved;
        emit Approval(msg.sender, approved, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approved[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owned");
        _ownerOf[tokenId] = to;
        delete _approved[tokenId];
        emit Transfer(from, to, tokenId);
    }
}

/// Minimal ERC-1155: mint, setApprovalForAll, isApprovedForAll, safeTransferFrom.
contract TestMulti {
    mapping(uint256 => mapping(address => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) private _operators;
    event TransferSingle(
        address indexed operator, address indexed from, address indexed to,
        uint256 id, uint256 value
    );
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function mint(address to, uint256 id, uint256 value) external {
        balanceOf[id][to] += value;
        emit TransferSingle(msg.sender, address(0), to, id, value);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        balanceOf[id][from] -= value;
        balanceOf[id][to] += value;
        emit TransferSingle(msg.sender, from, to, id, value);
    }
}
