// SPDX-License-Identifier: MIT
pragma solidity ^0.8.11;

// A tiny stand-in for forge-std so beginners need no extra installs.
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata) external view returns (address);
    function envOr(string calldata, uint256) external view returns (uint256);
    function envUint(string calldata) external view returns (uint256);
    function addr(uint256) external pure returns (address);
    function warp(uint256) external;
    function startBroadcast(uint256) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

function logUint(string memory label, uint256 n) view {
    (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(
        abi.encodeWithSignature("log(string,uint256)", label, n)
    );
    ok;
}

function logAddr(string memory label, address a) view {
    (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(
        abi.encodeWithSignature("log(string,address)", label, a)
    );
    ok;
}
