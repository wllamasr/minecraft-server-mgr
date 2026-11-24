//go:build !linux && !windows

package procstat

// Tree is not available here: there is no way to ask this system with the
// standard library alone.
func Tree(int) (Usage, error) { return Usage{}, ErrUnsupported }
