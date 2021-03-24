package local

import (
	"bytes"
	"encoding/hex"
	"fmt"

	"github.com/ipfs/go-log"
	"github.com/keep-network/tbtc/relay/pkg/btc"
)

var logger = log.Logger("relay-btc-local")

// Chain represents a local Bitcoin chain.
type Chain struct {
	headers []*btc.Header
}

// Connect connects to the local Bitcoin chain and returns a chain handle.
func Connect() (btc.Handle, error) {
	logger.Infof("connecting local Bitcoin chain")

	return &Chain{}, nil
}

// GetHeaderByHeight returns the block header for the given block height.
func (c *Chain) GetHeaderByHeight(height int64) (*btc.Header, error) {
	for _, header := range c.headers {
		if header.Height == height {
			return header, nil
		}
	}

	return nil, fmt.Errorf("no header with height [%v]", height)
}

// GetHeaderByDigest returns the block header for given digest (hash).
func (c *Chain) GetHeaderByDigest(
	digest btc.Digest,
) (*btc.Header, error) {
	for _, header := range c.headers {
		if bytes.Equal(header.Hash[:], digest[:]) {
			return header, nil
		}
	}

	return nil, fmt.Errorf(
		"no header with digest [%v]",
		hex.EncodeToString(digest[:]),
	)
}

// GetBlockCount returns the number of blocks in the longest blockchain
func (lc *Chain) GetBlockCount() (int64, error) {
	return int64(len(lc.headers)), nil
}

// SetHeaders set internal headers for testing purposes.
func (c *Chain) SetHeaders(headers []*btc.Header) {
	c.headers = headers
}
