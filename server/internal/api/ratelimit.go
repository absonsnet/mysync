package api

import (
	"sync"
	"time"
)

// rateLimiter is a small sliding-window counter keyed by an arbitrary string
// (device ID or remote address). It's intentionally lightweight because the
// expected load is small and reverse proxies handle the broader DoS defence.
//
// A plain fixed window lets a caller spend its whole allowance at the end of
// one window and again at the start of the next — a 2x burst straddling the
// boundary. We instead keep the previous window's count and weight it by how
// far into the current window we are, which smooths that edge without the
// bookkeeping of per-request timestamps.
type rateLimiter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	state     map[string]*limiterBucket
	lastSweep time.Time
}

type limiterBucket struct {
	count     int
	prevCount int
	startedAt time.Time
}

func newRateLimiter(limitPerWindow int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		limit:     limitPerWindow,
		window:    window,
		state:     make(map[string]*limiterBucket),
		lastSweep: time.Now(),
	}
}

// allow returns (true, 0) when the request is permitted, or (false, retryAfter)
// when the caller has exceeded its quota. retryAfter is the duration until
// enough of the weighted window has elapsed for another request to fit.
func (rl *rateLimiter) allow(key string) (bool, time.Duration) {
	if rl == nil || rl.limit <= 0 {
		return true, 0
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	rl.maybeSweep(now)

	bucket, ok := rl.state[key]
	if !ok {
		rl.state[key] = &limiterBucket{count: 1, startedAt: now}
		return true, 0
	}

	// Advance the window: one step forward keeps the previous count as
	// context; two or more means the caller has been idle and starts clean.
	elapsed := now.Sub(bucket.startedAt)
	if elapsed >= 2*rl.window {
		bucket.prevCount = 0
		bucket.count = 0
		bucket.startedAt = now
		elapsed = 0
	} else if elapsed >= rl.window {
		bucket.prevCount = bucket.count
		bucket.count = 0
		bucket.startedAt = bucket.startedAt.Add(rl.window)
		elapsed = now.Sub(bucket.startedAt)
	}

	// Fraction of the previous window still "visible" from where we stand.
	carry := float64(bucket.prevCount) * (1 - float64(elapsed)/float64(rl.window))
	if carry < 0 {
		carry = 0
	}

	if float64(bucket.count)+carry >= float64(rl.limit) {
		retryAfter := rl.window - elapsed
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
		return false, retryAfter
	}

	bucket.count++
	return true, 0
}

// maybeSweep lazily evicts idle buckets so the map doesn't grow unbounded as
// devices come and go. We only do this at most every `window`.
func (rl *rateLimiter) maybeSweep(now time.Time) {
	if now.Sub(rl.lastSweep) < rl.window {
		return
	}
	rl.lastSweep = now
	for k, bucket := range rl.state {
		if now.Sub(bucket.startedAt) >= 2*rl.window {
			delete(rl.state, k)
		}
	}
}
