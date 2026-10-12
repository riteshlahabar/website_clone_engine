<?php
/**
 * Writes the Customizer's "Additional CSS" for the active theme.
 *
 *   wp eval-file php/set-custom-css.php <css-file> --path=<site>
 *
 * Used for small theme-level corrections the Elementor kit cannot express —
 * notably constraining the site logo, which themes render at the image's
 * natural size and which therefore looks broken for any logo that is not
 * already cropped to a header-friendly shape.
 *
 * Additional CSS lives in a `custom_css` post, so wp_update_custom_css_post()
 * is the supported way in; there is no option to set directly.
 */

if ( ! defined( 'ABSPATH' ) ) {
	WP_CLI::error( 'This script must be run through `wp eval-file`.' );
}
if ( empty( $args[0] ) || ! file_exists( $args[0] ) ) {
	WP_CLI::error( 'Usage: wp eval-file set-custom-css.php <css-file>' );
}

$css    = file_get_contents( $args[0] );
$result = wp_update_custom_css_post( $css );

if ( is_wp_error( $result ) ) {
	WP_CLI::error( 'Could not save custom CSS: ' . $result->get_error_message() );
}

WP_CLI::success( sprintf( 'Custom CSS saved (%d bytes).', strlen( $css ) ) );
