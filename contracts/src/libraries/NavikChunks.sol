// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Reads content stored as SSTORE2 data contracts ("chunks"): the code of each pointer minus
/// its leading STOP byte. Code cannot change after deployment, so chunks are immutable.
library NavikChunks {
    error MissingChunk(address pointer);

    /// Max bytes per chunk: EIP-170 code size limit (24,576) minus the STOP prefix.
    uint256 internal constant CHUNK_SIZE = 24_575;

    /// Concatenates the data of `pointers`, in order.
    function read(address[] memory pointers) internal view returns (bytes memory out) {
        uint256 total;
        for (uint256 i; i < pointers.length; ++i) {
            total += length(pointers[i]);
        }
        out = new bytes(total);
        uint256 offset;
        for (uint256 i; i < pointers.length; ++i) {
            address p = pointers[i];
            uint256 len = p.code.length - 1;
            assembly ("memory-safe") {
                extcodecopy(p, add(add(out, 0x20), offset), 1, len)
            }
            offset += len;
        }
    }

    /// Data length of one chunk; reverts if `pointer` holds no code.
    function length(address pointer) internal view returns (uint256) {
        uint256 size = pointer.code.length;
        if (size == 0) revert MissingChunk(pointer);
        return size - 1;
    }
}
